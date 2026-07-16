import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as readline from 'readline';
import { URL } from 'url';
import { Command } from 'commander';
import { loadSettingsForRoot } from '../core/settingsLoader';
import { OfficeSocket } from '../officeSocket';
import { CLI_VERSION } from '../version';

/**
 * `autodev mcp-operate` — run a local stdio MCP server that lets a pure MCP
 * client (Claude Desktop/Code, etc.) operate a pixel-office character with NO
 * autodev loop. It is a transparent JSON-RPC bridge: the client speaks the MCP
 * stdio transport (newline-delimited JSON on stdin/stdout); each request is
 * forwarded to the pixel-office operator MCP (`…/api/office-mcp`) authenticated
 * with the character's api_key, and the response is written back.
 *
 * Why stdio (vs adding the remote HTTP MCP directly): the client adds it with a
 * single command — no remote-server approval friction, and the key/url stay in
 * autodev config instead of being pasted into the client.
 *
 *   claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <…/api/office-mcp>
 *   # or, inside a bound workspace, just:  autodev mcp-operate
 */

/** Derive the operator-MCP URL from a bound workspace's serverBaseUrl. */
function officeMcpUrl(serverBaseUrl: string | undefined): string {
  try {
    const u = new URL(serverBaseUrl || '');
    // serverBaseUrl is derived from wsUrl (wss://host/ws) — normalise to the
    // HTTP origin; the MCP endpoint lives at <origin>/api/office-mcp.
    const proto = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
    return `${proto}//${u.host}/api/office-mcp`;
  } catch {
    return '';
  }
}

/** Derive the presence WebSocket URL (…/ws) from the operator-MCP endpoint. */
export function officeWsUrl(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const proto = u.protocol === 'http:' ? 'ws:' : u.protocol === 'https:' ? 'wss:' : u.protocol;
    return `${proto}//${u.host}/ws`;
  } catch {
    return '';
  }
}

/** Turn a server WS push into a one-line human notice, or null to ignore it. */
export function describePush(msg: Record<string, unknown>): string | null {
  const type = msg['type'];
  if (type === 'new_task') {
    const task = (msg['data'] as { task?: { title?: string } } | undefined)?.task;
    return task?.title ? `New task: ${task.title}` : 'New task assigned.';
  }
  // Office-feed events fanned out to connected agents (chat, status,
  // celebrations, joins…): { type:'office_event', event, fromName, text }. The
  // feed text is already self-contained (usually names the actor), so surface it
  // as-is rather than double-prefixing.
  if (type === 'office_event') {
    const text = (msg['text'] as string) || '';
    const from = (msg['fromName'] as string) || (msg['from'] as string) || 'a teammate';
    return text || `${from} posted an office update`;
  }
  // Tool-activity (hook) events from teammates: { type:'hook_event', agentName, toolName, eventName }.
  if (type === 'hook_event') {
    const data = (msg['data'] as Record<string, unknown> | undefined) ?? msg;
    const who = (data['agentName'] as string) || (msg['agentName'] as string) || 'a teammate';
    const tool = (data['toolName'] as string) || (msg['toolName'] as string) || '';
    const ev = (data['eventType'] as string) || (msg['eventName'] as string) || 'activity';
    return `🔧 ${who}: ${tool || ev}`;
  }
  // A2A task/message push frame: { task: { metadata: { task: { text }, event } } }
  const task = msg['task'] as { metadata?: { task?: { text?: string }; event?: string } } | undefined;
  if (task?.metadata) {
    const text = task.metadata.task?.text;
    return text ? `New message: ${text}` : 'You have a new message.';
  }
  return null;
}

/** POST a JSON-RPC message to the remote operator MCP; resolve its JSON reply. */
function proxy(endpoint: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': data.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        // A notification (204/202, no body) has nothing to forward.
        if (!d.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(d) as Record<string, unknown>); }
        catch (e) { reject(e); }
      });
    });
    // Without a timeout, an office that accepts the connection but never
    // responds would leave this promise pending forever — the bridge's
    // inflight counter never returns to 0 and the process can't exit.
    req.setTimeout(120_000, () => req.destroy(new Error('proxy request timed out after 120s')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function mcpOperateCommand(program: Command): void {
  program
    .command('mcp-operate [path]')
    .description('Run a stdio MCP server that operates a pixel-office agent (bridges to …/api/office-mcp). Add it with: claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <url>')
    .option('--url <url>', 'Operator MCP URL (…/api/office-mcp). Default: derived from the workspace binding.')
    .option('--key <apiKey>', 'The character api_key (Bearer). Default: the workspace serverApiKey.')
    .option('--no-socket', 'Do not open the presence WebSocket (stay on poll-based presence only).')
    .action(async (workspacePath: string | undefined, opts: { url?: string; key?: string; socket?: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);
      const endpoint = opts.url || officeMcpUrl(settings.serverBaseUrl);
      const key = opts.key || settings.serverApiKey || '';

      if (!endpoint || !key) {
        process.stderr.write('autodev mcp-operate: need --url and --key (or run inside a workspace bound to an office).\n');
        process.exit(1);
        return;
      }
      // Everything below goes to stdout as MCP frames — keep it clean; log to stderr.
      process.stderr.write(`autodev mcp-operate → ${endpoint}\n`);

      const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };
      const rl = readline.createInterface({ input: process.stdin, terminal: false });

      // ── Real-time event stream over the presence socket ──────────────────────
      // The socket receives office activity live; buffer it here and expose a
      // `wait_for_events` tool that blocks until something arrives (or a timeout).
      // A driven agent loops on it to react in real time — through the tool
      // channel, since MCP clients don't surface server notifications into the
      // model's context.
      const EVENT_CAP = 200;
      const eventQueue: string[] = [];
      let eventWaiter: (() => void) | null = null;
      const pushEvent = (line: string): void => {
        eventQueue.push(line);
        if (eventQueue.length > EVENT_CAP) { eventQueue.splice(0, eventQueue.length - EVENT_CAP); }
        if (eventWaiter) { const w = eventWaiter; eventWaiter = null; w(); }
      };
      const waitForEvent = (ms: number): Promise<void> => new Promise((resolve) => {
        const timer = setTimeout(() => { eventWaiter = null; resolve(); }, ms);
        eventWaiter = () => { clearTimeout(timer); resolve(); };
      });
      const WAIT_TOOL = {
        name: 'wait_for_events',
        description: "Block until new office activity arrives over the live socket (or a timeout), then return it. Teammates' messages, status changes, task assignments and tool activity stream in as they happen — call this in a loop to react in real time. Returns any buffered events immediately.",
        inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'integer', description: 'Max seconds to wait for the next event (default 25, max 55).' } }, required: [] as string[] },
      };

      // ── Presence WebSocket (optional; --no-socket disables) ──────────────────
      // Holds a live connection so the office shows this MCP agent genuinely
      // online, and surfaces task/message pushes to the client as MCP
      // notifications the moment they arrive. Purely additive — if it can't
      // connect, the stdio bridge keeps working and presence falls back to the
      // server's poll heuristic.
      let socket: OfficeSocket | null = null;
      const startSocket = async (): Promise<void> => {
        if (opts.socket === false) { return; }
        const wsUrl = officeWsUrl(endpoint);
        if (!wsUrl) { return; }
        // The slug is needed for the ?endpoint= WS auth. Prefer the workspace
        // binding — it works for EVERY endpoint, including the A2A one
        // (…/api/mcp/a2a), which has no whoami tool. Fall back to whoami only for a
        // raw --url/--key invocation with no bound settings.
        let slug = (settings.webhookSlug || '').trim();
        if (!slug) {
          try {
            const who = await proxy(endpoint, key, { jsonrpc: '2.0', id: 'boot-whoami', method: 'tools/call', params: { name: 'whoami', arguments: {} } });
            const text = (((who['result'] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? '');
            slug = (text.match(/slug:\s*([a-z0-9][a-z0-9-]*)/i)?.[1]) ?? '';
          } catch { /* whoami failed — skip presence, bridge still works */ }
        }
        if (!slug) { process.stderr.write('autodev mcp-operate: could not resolve slug — presence socket disabled.\n'); return; }

        socket = new OfficeSocket(wsUrl, key, slug, {
          log: (l) => process.stderr.write(l + '\n'),
          meta: { provider: 'mcp-operator', cliVersion: CLI_VERSION, fileBrowserEnabled: false },
          onMessage: (msg) => {
            const notice = describePush(msg);
            if (notice) {
              // Buffer for wait_for_events (the reliable real-time path)…
              pushEvent(`- ${new Date().toISOString()} ${notice}`);
              // …and also emit a logging notification for clients that show them.
              send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'pixel-office', data: notice } });
            }
          },
        });
        socket.start();
      };
      void startSocket();

      // Drain in-flight requests before exiting when stdin closes, so a reply
      // in progress is never clipped.
      let inflight = 0;
      let closed = false;
      const maybeExit = (): void => {
        if (closed && inflight === 0) {
          socket?.destroy();
          // Flush any buffered stdout (e.g. the final reply on a pipe) before
          // exiting, so the last frame is never clipped.
          process.stdout.write('', () => process.exit(0));
        }
      };

      rl.on('line', async (line: string) => {
        const t = line.trim();
        if (!t) { return; }
        let req: { id?: unknown; method?: string };
        try { req = JSON.parse(t); } catch { return; }

        // Notifications (no id) are one-way — nothing to reply. Forward the
        // handshake ones opportunistically but never write a response for them.
        if (req.id === undefined || req.id === null) {
          if (typeof req.method === 'string' && req.method.startsWith('notifications/')) {
            proxy(endpoint, key, req).catch(() => { /* best effort */ });
          }
          return;
        }

        // Local tool: wait_for_events — stream office activity from the socket
        // instead of proxying to the server. Blocks until an event (or timeout).
        const params = (req as { params?: { name?: string; arguments?: { timeout_seconds?: unknown } } }).params;
        if (req.method === 'tools/call' && params?.name === 'wait_for_events') {
          inflight++;
          try {
            const secs = Math.max(1, Math.min(55, Number(params?.arguments?.timeout_seconds) || 25));
            if (eventQueue.length === 0) { await waitForEvent(secs * 1000); }
            const events = eventQueue.splice(0, eventQueue.length);
            const text = events.length
              ? `Office activity (${events.length} event${events.length === 1 ? '' : 's'}):\n${events.join('\n')}\n\nUse get_events / check_messages for detail, then call wait_for_events again to keep listening.`
              : `No new events in ${secs}s. Call wait_for_events again to keep listening.`;
            send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } });
          } finally { inflight--; maybeExit(); }
          return;
        }

        inflight++;
        try {
          const res = await proxy(endpoint, key, req);
          // Advertise the local streaming tool alongside the server's own tools.
          if (req.method === 'tools/list') {
            const result = res['result'] as { tools?: unknown[] } | undefined;
            if (result && Array.isArray(result.tools)) { result.tools.push(WAIT_TOOL); }
          }
          send(res);
        } catch (e) {
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'proxy error: ' + ((e as Error)?.message ?? String(e)) } });
        } finally {
          inflight--;
          maybeExit();
        }
      });

      rl.on('close', () => { closed = true; maybeExit(); });
    });
}
