import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as readline from 'readline';
import { URL } from 'url';
import { Command } from 'commander';
import { loadSettingsForRoot } from '../core/settingsLoader';
import { OfficeSocket } from '../officeSocket';
import { handleFbRequest } from '../fileBrowser';
import { handleGitRequest } from '../git/gitRequest';
import { VncSessionManager } from '../vnc/manager';
import { RdpSessionManager } from '../rdp/manager';
import { saveProjectUserMcp, sanitizeRemoteMcpEntries } from '../core/projectMcp';
import { ConfigManager } from '../configManager';
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
    .option('--file-browser', 'Serve the office file browser for this MCP-only agent (read/write files in the workspace over the office file browser).')
    .option('--git', 'Serve the office git panel for this MCP-only agent (status/diff/stage/commit/branch in the workspace over the office git panel).')
    .option('--vnc', 'Serve office VNC remote-desktop sessions for this MCP-only agent (input forwarding + framebuffer streaming).')
    .option('--rdp', 'Serve office RDP remote-desktop sessions for this MCP-only agent (input forwarding + framebuffer streaming).')
    .option('--mcp-update', 'Honor mcp_update frames: sync remote-supplied MCP config into the workspace (relaunch to pick up spawn changes).')
    .action(async (workspacePath: string | undefined, opts: { url?: string; key?: string; socket?: boolean; fileBrowser?: boolean; git?: boolean; vnc?: boolean; rdp?: boolean; mcpUpdate?: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      let settings = loadSettingsForRoot(cwd);
      const endpoint = opts.url || officeMcpUrl(settings.serverBaseUrl);
      const key = opts.key || settings.serverApiKey || '';
      // Feature gates: serve a capability when explicitly requested via flag OR
      // when the bound workspace has it enabled (same flags a loop agent honours
      // via settings). Mutable so a live mcp_update can refresh them from disk.
      let fileBrowserEnabled = opts.fileBrowser === true || settings.enableFileBrowser === true;
      let gitEnabled         = opts.git === true         || settings.gitEnabled === true;
      let vncEnabled         = opts.vnc === true         || settings.vncEnabled === true;
      let rdpEnabled         = opts.rdp === true         || settings.rdpEnabled === true;
      let mcpUpdateEnabled   = opts.mcpUpdate === true   || settings.mcpUpdateEnabled === true;

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

      // ── VNC / RDP remote-desktop session managers ────────────────────────────
      // Reuse the exact same session machinery the autodev loop uses. They reply
      // to the office over the presence socket. Gated by --vnc/--rdp (or the
      // bound workspace's vncEnabled/rdpEnabled), mirroring --file-browser.
      const logErr = (m: string): void => { process.stderr.write(m + '\n'); };
      const vncManager = new VncSessionManager((f) => socket?.sendFrame(f), logErr);
      const rdpManager = new RdpSessionManager((f) => socket?.sendFrame(f), logErr);
      const applyRemoteDesktopSettings = (): void => {
        vncManager.setEnabled(vncEnabled);
        vncManager.setPassword(settings.vncPassword || undefined);
        rdpManager.setEnabled(rdpEnabled);
        rdpManager.setSettings({
          host:      settings.rdpHost      || undefined,
          port:      settings.rdpPort      ?? 3389,
          username:  settings.rdpUsername  || undefined,
          password:  settings.rdpPassword  || undefined,
          domain:    settings.rdpDomain    || undefined,
          guacWsUrl: settings.rdpGuacWsUrl || undefined,
        });
      };
      applyRemoteDesktopSettings();

      // Re-read the workspace settings from disk and recompute the mutable
      // feature gates (an explicit CLI flag stays sticky — it can enable a
      // capability the settings file leaves off). Used on live mcp_update, the
      // bridge analog of the loop re-reading everything on its restart.
      const reloadBridgeSettings = (): void => {
        settings = loadSettingsForRoot(cwd);
        fileBrowserEnabled = opts.fileBrowser === true || settings.enableFileBrowser === true;
        gitEnabled         = opts.git === true         || settings.gitEnabled === true;
        vncEnabled         = opts.vnc === true         || settings.vncEnabled === true;
        rdpEnabled         = opts.rdp === true         || settings.rdpEnabled === true;
        mcpUpdateEnabled   = opts.mcpUpdate === true   || settings.mcpUpdateEnabled === true;
        applyRemoteDesktopSettings();
      };

      // ── Live MCP-config reload (mcp_update frame) ────────────────────────────
      // The loop restarts to pick up a new .mcp.json; a bridge can't restart, so
      // it syncs the config to disk (gated by mcpUpdateEnabled) and logs that a
      // relaunch is needed to spawn any newly-added stdio MCP servers. It also
      // refreshes the bridge's own feature gates from disk (fileBrowser/git/…).
      const handleMcpUpdate = (entries: Record<string, unknown>): void => {
        // Refresh feature gates from disk first — mirrors the loop re-reading
        // settings on restart (a settings edit often accompanies an mcp_update).
        reloadBridgeSettings();
        if (!mcpUpdateEnabled) {
          logErr('🔒 mcp_update ignored — mcpUpdateEnabled is off (set it in .autodev/settings.json or pass --mcp-update to allow)');
          return;
        }
        logErr('🔧 mcp_update received — validating and writing .mcp.json…');
        const { safe, rejected } = sanitizeRemoteMcpEntries(entries);
        if (rejected.length) {
          logErr(`⚠️ mcp_update dropped ${rejected.length} unsafe entr${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}`);
        }
        if (Object.keys(safe).length === 0) {
          logErr('⚠️ mcp_update had no safe entries — not writing config.');
          return;
        }
        try {
          saveProjectUserMcp(cwd, safe);
          ConfigManager.syncProjectMcpServers(cwd, logErr);
          void ConfigManager.reportProjectMcp(cwd, logErr);
          logErr('✅ MCP config synced to .mcp.json, opencode.json, .vscode/mcp.json — relaunch `autodev mcp-operate` to spawn any newly-added MCP servers.');
        } catch (err) {
          logErr(`⚠️ MCP update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

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
          meta: {
            provider: 'mcp-operator', cliVersion: CLI_VERSION,
            fileBrowserEnabled, gitEnabled, vncEnabled, rdpEnabled,
            // Announce the desktop host/port too (parity with the loop's meta) so
            // the office persists the real target instead of defaulting to :5900.
            // Only when enabled — an off feature must not pin a stale port.
            vncHost: vncEnabled ? (settings.vncHost || undefined) : undefined,
            vncPort: vncEnabled ? (settings.vncPort ?? 5900) : undefined,
            rdpHost: rdpEnabled ? (settings.rdpHost || undefined) : undefined,
            rdpPort: rdpEnabled ? (settings.rdpPort ?? 3389) : undefined,
          },
          onMessage: (msg) => {
            const msgType = msg['type'] as string | undefined;

            // File-browser control frame from the office UI. Handle it and stop —
            // it is not an office event to surface via describePush/notifications.
            if (msgType === 'fb_request') {
              const requestId = msg['requestId'] as string | undefined;
              const action    = msg['action']    as string | undefined;
              if (requestId && action) {
                handleFbRequest({
                  root: cwd,
                  enabled: fileBrowserEnabled,
                  requestId,
                  action,
                  relPath: (msg['path'] as string | undefined) ?? '',
                  content: msg['content'] as string | undefined,
                  newPath: msg['newPath'] as string | undefined,
                  query:   msg['query']   as string | undefined,
                  sendFrame: (f) => socket?.sendFrame(f),
                  log: (m) => process.stderr.write(m + '\n'),
                });
              }
              return;
            }

            // Git-panel control frame from the office UI — same additive,
            // early-return handling as fb_request. Gated by gitEnabled.
            if (msgType === 'git_request') {
              const requestId = msg['requestId'] as string | undefined;
              const action    = msg['action']    as string | undefined;
              if (requestId && action) {
                handleGitRequest({
                  root: cwd,
                  enabled: gitEnabled,
                  requestId,
                  action,
                  filePath: msg['path']    as string | undefined,
                  staged:   msg['staged']  as boolean | undefined,
                  message:  msg['message'] as string | undefined,
                  branch:   msg['branch']  as string | undefined,
                  hash:     msg['hash']    as string | undefined,
                  sendFrame: (f) => socket?.sendFrame(f),
                  log: (m) => process.stderr.write(m + '\n'),
                });
              }
              return;
            }

            // VNC / RDP remote-desktop control frames — delegated to the shared
            // session managers (same machinery as the loop). Each returns true
            // when it consumed the frame; consumed frames are not office events.
            if (msgType && vncManager.handleFrame(msgType, msg)) { return; }
            if (msgType && rdpManager.handleFrame(msgType, msg)) { return; }

            // Live MCP-config reload frame from the office.
            if (msgType === 'mcp_update') {
              const entries = msg['mcpServers'] as Record<string, unknown> | undefined;
              if (entries && typeof entries === 'object') { handleMcpUpdate(entries); }
              return;
            }

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

      // ── Forward the client session's OWN tool activity to the office ─────────
      // A loop agent (`autodev start`) tails .autodev/hooks-events.jsonl and ships
      // each Claude/Copilot/opencode hook to the office. An mcp-operate bridge did
      // NOT — so a VS Code / Claude Code session's native Edit/Bash/Read calls
      // (which never pass through the office MCP) never reached the office: the
      // Events tab stayed empty and the badge stayed idle even while the session
      // was actively coding. Mirror the loop here: tail the jsonl, forward new
      // lines as `hook_event` frames over the presence socket, and derive a
      // debounced working/idle status from the same stream.
      //
      // Safe when there are no hooks (the file simply never appears → no-op) and
      // when --no-socket is set (no presence channel to forward over).
      const startHookForwarding = (): void => {
        if (opts.socket === false) { return; }
        const hooksJsonl = path.join(cwd, '.autodev', 'hooks-events.jsonl');
        // Start at the current size so we forward only NEW activity, never replay
        // the (potentially huge) backlog on connect.
        let offset = 0;
        try { offset = fs.existsSync(hooksJsonl) ? fs.statSync(hooksJsonl).size : 0; } catch { offset = 0; }
        const seen = new Map<string, number>();
        const DEDUPE_MS = 30_000;
        const sessionNameForHooks = (settings.sessionName && settings.sessionName.trim()) || path.basename(cwd);

        // Debounced status: flip to 'working' on the first tool activity and back
        // to 'idle' after this long with none. Only real transitions are sent (the
        // office no-ops an unchanged status), so an active session posts one
        // "working" per burst rather than a heartbeat spam.
        const IDLE_AFTER_MS = 120_000;
        let reportedStatus: 'working' | 'idle' | null = null;
        let idleTimer: NodeJS.Timeout | null = null;
        const reportStatus = (status: 'working' | 'idle'): void => {
          if (reportedStatus === status) { return; }
          reportedStatus = status;
          proxy(endpoint, key, { jsonrpc: '2.0', id: `mcpop-status-${status}-${Date.now()}`, method: 'tools/call', params: { name: 'set_status', arguments: { status } } })
            .catch(() => { /* best-effort — presence still works without it */ });
        };
        const markWorking = (): void => {
          reportStatus('working');
          if (idleTimer) { clearTimeout(idleTimer); }
          idleTimer = setTimeout(() => reportStatus('idle'), IDLE_AFTER_MS);
          idleTimer.unref?.();
        };
        // Hook names that mean the session is actively doing work.
        const WORKING_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification']);

        const tick = (): void => {
          if (!socket) { return; }               // wait until the presence socket is up
          try {
            if (!fs.existsSync(hooksJsonl)) { return; }
            const size = fs.statSync(hooksJsonl).size;
            if (size <= offset) { return; }
            const fd = fs.openSync(hooksJsonl, 'r');
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = size;
            const now = Date.now();
            for (const [h, ts] of seen) { if (now - ts > DEDUPE_MS) { seen.delete(h); } }
            let sawWork = false;
            for (const line of buf.toString('utf8').split('\n')) {
              const t = line.trim();
              if (!t) { continue; }
              const h = crypto.createHash('sha1').update(t).digest('hex');
              const at = seen.get(h);
              if (at !== undefined && now - at <= DEDUPE_MS) { continue; }
              seen.set(h, now);
              try {
                const ev = JSON.parse(t) as Record<string, unknown>;
                // Skip MCP tool calls. Office-MCP tools (get_tasks, write_file, …)
                // that this bridge proxies are ALREADY logged server-side by the
                // office (emitToolHook), so forwarding the client's own hook for
                // them double-logs; and forwarding office-poll calls (get_tasks/
                // wait_for_events every cycle) would spam the Events tab and, via
                // the status heuristic below, keep an idle task-loop agent looking
                // busy — the exact noise operate.sh avoids. The high-value signal
                // is the session's NATIVE tools (Edit/Bash/Read/Write/…), which a
                // free-form VS Code session uses and the office otherwise never sees.
                const toolName = (ev['tool_name'] as string) || '';
                if (toolName.startsWith('mcp__')) { continue; }
                ev._session_name = sessionNameForHooks;   // so the office can label it
                socket.sendFrame({ type: 'hook_event', data: ev });
                const name = (ev['hook_event_name'] as string) || (ev['hook'] as string) || (ev['event'] as string) || '';
                if (WORKING_HOOKS.has(name)) { sawWork = true; }
              } catch { /* skip malformed lines */ }
            }
            if (sawWork) { markWorking(); }
          } catch { /* ignore transient read errors */ }
        };
        const interval = setInterval(tick, 5_000);
        interval.unref?.();
      };
      startHookForwarding();

      // Drain in-flight requests before exiting when stdin closes, so a reply
      // in progress is never clipped.
      let inflight = 0;
      let closed = false;
      const maybeExit = (): void => {
        if (closed && inflight === 0) {
          vncManager.stopAll();
          rdpManager.stopAll();
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
