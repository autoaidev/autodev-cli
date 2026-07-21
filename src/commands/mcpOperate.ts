import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { URL } from 'url';
import { Command } from 'commander';
import { loadSettingsForRoot } from '../core/settingsLoader';
import { OfficeSocket } from '../officeSocket';
import { foreignLoopOwner, readPresenceLock } from '../presenceGuard';
import { handleFbRequest } from '../fileBrowser';
import { handleGitRequest } from '../git/gitRequest';
import { VncSessionManager } from '../vnc/manager';
import { RdpSessionManager } from '../rdp/manager';
import { saveProjectUserMcp, sanitizeRemoteMcpEntries } from '../core/projectMcp';
import { ConfigManager } from '../configManager';
import { CLI_VERSION } from '../version';
import { buildNotificationEvent } from '../core/liveNarration';

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
    .description('Run an MCP server that operates a pixel-office agent (bridges to …/api/office-mcp). Speaks stdio by default; add --http-port to run a PERSISTENT streamable-HTTP sidecar an opencode `type: remote` MCP can attach to. Add stdio with: claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <url>')
    .option('--url <url>', 'Operator MCP URL (…/api/office-mcp). Default: derived from the workspace binding.')
    .option('--key <apiKey>', 'The character api_key (Bearer). Default: the workspace serverApiKey.')
    .option('--http-port <port>', 'Run a persistent MCP-over-HTTP (Streamable HTTP) server on this port instead of stdio. Point an opencode `type: remote` MCP at http://<host>:<port>/mcp.', (v) => parseInt(v, 10))
    .option('--http-host <host>', 'Bind address for --http-port (default 127.0.0.1).')
    .option('--no-socket', 'Do not open the presence WebSocket (stay on poll-based presence only).')
    .option('--file-browser', 'Serve the office file browser for this MCP-only agent (read/write files in the workspace over the office file browser).')
    .option('--git', 'Serve the office git panel for this MCP-only agent (status/diff/stage/commit/branch in the workspace over the office git panel).')
    .option('--vnc', 'Serve office VNC remote-desktop sessions for this MCP-only agent (input forwarding + framebuffer streaming).')
    .option('--rdp', 'Serve office RDP remote-desktop sessions for this MCP-only agent (input forwarding + framebuffer streaming).')
    .option('--mcp-update', 'Honor mcp_update frames: sync remote-supplied MCP config into the workspace (relaunch to pick up spawn changes).')
    .action(async (workspacePath: string | undefined, opts: { url?: string; key?: string; socket?: boolean; fileBrowser?: boolean; git?: boolean; vnc?: boolean; rdp?: boolean; mcpUpdate?: boolean; httpPort?: number; httpHost?: string }) => {
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

      // ── Route office tool calls over the SAME presence socket ────────────────
      // Instead of a second HTTP connection, forward each JSON-RPC request as an
      // `operator_request` frame over the socket we already hold and await the
      // matching `operator_response`. Falls back to the HTTP proxy only when the
      // socket isn't up (startup slug-resolve, or --no-socket).
      const wsPending = new Map<string, (resp: Record<string, unknown>) => void>();
      let wsReqSeq = 0;
      // Only route over the socket once it is genuinely CONNECTED (open + agent_online
      // sent), never merely constructed — else the initialize handshake fires an
      // operator_request over a still-connecting socket, gets no reply, and the MCP
      // client (VS Code) hangs on "Connecting…". A 20s timeout means any dropped
      // request fails over to HTTP quickly instead of stalling.
      const wsReady = (): boolean => !!socket && socket.isConnected();
      const proxyOverWs = (body: { id?: unknown; method?: string; params?: unknown }): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          if (!wsReady()) { reject(new Error('socket not ready')); return; }
          const id = body.id !== undefined && body.id !== null ? body.id : `wsreq-${++wsReqSeq}`;
          const k = String(id);
          const timer = setTimeout(() => { wsPending.delete(k); reject(new Error('operator_request timed out')); }, 20_000);
          wsPending.set(k, (resp) => { clearTimeout(timer); resolve(resp); });
          socket!.sendFrame({ type: 'operator_request', id, method: body.method, params: body.params ?? {} });
        });
      // Prefer the socket when ready; fall back to HTTP otherwise (startup handshake,
      // brief post-connect window, or --no-socket).
      const callOffice = (body: { id?: unknown; method?: string; params?: unknown }): Promise<Record<string, unknown>> =>
        wsReady() ? proxyOverWs(body).catch(() => proxy(endpoint, key, body)) : proxy(endpoint, key, body);

      // Wakes the autonomy loop (set by startAutonomy). The EXISTING socket's
      // task/message pushes call this — the same connection that keeps us online
      // also drives the work; no second connection, no polling loop of our own.
      let triggerWork: () => void = () => { /* set by startAutonomy */ };

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

      // ── Presence socket lifecycle (runtime-driven, self-healing) ─────────────
      // Whether the bridge holds the presence socket is decided at RUNTIME from
      // ACTUAL loop presence, NOT a static config flag. A co-located `autodev
      // start` loop drops+refreshes .autodev/ws-presence.lock; while a live loop
      // owns the slug the bridge stays poll-only — the loop owns presence + steer
      // delivery, and a 2nd (last-wins) socket would steal the slug and swallow the
      // instant messages the loop is meant to deliver. With NO live loop the bridge
      // keeps its socket = the MCP-only agent's only presence signal (so it shows
      // online). A periodic reconcile (set up after the lifecycle flags below)
      // yields or re-opens as loops appear/die, so a grok-respawn race self-heals in
      // seconds instead of flapping forever. Liveness uses the SAME rules as
      // presenceGuard (foreignLoopOwner: pid alive + ts fresh) so the loop and the
      // bridge always agree on "is a loop alive".
      const wsUrl = officeWsUrl(endpoint);
      let presenceSlug: string | null = null;
      let openingSocket = false;

      // True when a DIFFERENT, still-alive loop currently owns this workspace's
      // presence (fresh ws-presence.lock with a live pid) — then the bridge must
      // NOT hold a socket. Null → no owner → the bridge may own presence itself.
      const loopOwnsPresence = (): boolean => foreignLoopOwner(readPresenceLock(cwd)) !== null;

      // Resolve the office slug once (workspace binding preferred — it works for
      // EVERY endpoint including the A2A one, which has no whoami tool; whoami only
      // as a fallback for a raw --url/--key invocation). Cached so a socket re-open
      // after a loop exits never re-runs whoami.
      const resolveSlug = async (): Promise<string | null> => {
        if (presenceSlug) { return presenceSlug; }
        let slug = (settings.webhookSlug || '').trim();
        if (!slug) {
          try {
            const who = await proxy(endpoint, key, { jsonrpc: '2.0', id: 'boot-whoami', method: 'tools/call', params: { name: 'whoami', arguments: {} } });
            const text = (((who['result'] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? '');
            slug = (text.match(/slug:\s*([a-z0-9][a-z0-9-]*)/i)?.[1]) ?? '';
          } catch { /* whoami failed — skip presence, bridge still works */ }
        }
        presenceSlug = slug || null;
        return presenceSlug;
      };

      const buildSocket = (slug: string): OfficeSocket => new OfficeSocket(wsUrl, key, slug, {
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

            // Reply to a tool call we sent over the socket (operator_request).
            if (msgType === 'operator_response') {
              const rid = String(msg['id'] ?? '');
              const w = wsPending.get(rid);
              if (w) { wsPending.delete(rid); w({ jsonrpc: '2.0', id: msg['id'], result: msg['result'], error: msg['error'] }); }
              return;
            }

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
            // A new task or an inbound message → wake the autonomy loop to work it.
            if (msgType === 'new_task' || (msg['task'] as { metadata?: unknown } | undefined)?.metadata) {
              triggerWork();
            }
          },
      });

      // Open the presence socket UNLESS: manually disabled (--no-socket), the
      // bridge went dormant (superseded by a newer bridge) or is shutting down, we
      // already hold a socket, an open is in flight, or a live loop already owns
      // presence. Guards are re-checked AFTER the async slug resolve (a loop may
      // appear, or we may be superseded, while whoami is in flight).
      const ensurePresenceSocket = async (): Promise<void> => {
        if (opts.socket === false || superseded || closed) { return; }
        if (socket || openingSocket) { return; }
        if (!wsUrl || loopOwnsPresence()) { return; }
        openingSocket = true;
        try {
          const slug = await resolveSlug();
          if (!slug) { process.stderr.write('autodev mcp-operate: could not resolve slug — presence socket disabled.\n'); return; }
          // opts.socket can't change across the await; re-check the mutable guards.
          if (superseded || closed || socket || loopOwnsPresence()) { return; }
          socket = buildSocket(slug);
          socket.start();
          process.stderr.write(`autodev mcp-operate: no live loop owns slug '${slug}' — opening presence socket (this bridge is presence).\n`);
        } finally { openingSocket = false; }
      };

      // A live loop has (re)taken the slug → drop our presence socket so the loop
      // owns presence + steer delivery (its socket is last-wins on the server
      // anyway). HTTP tools keep working; presence is deferred to the loop.
      const yieldPresenceToLoop = (): void => {
        if (!socket) { return; }
        process.stderr.write('autodev mcp-operate: a live loop now owns this slug — closing bridge presence socket (loop delivers steers).\n');
        try { socket.destroy(); } catch { /* ignore */ }
        socket = null;
      };

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

        // ── Assistant NARRATION from the session transcript ──────────────────
        // The office chat renders the agent's prose ("Let me update the backlog…")
        // as bubbles, but Claude Code fires NO hook carrying assistant text — it
        // lives only in the session transcript (~/.claude/projects/…/<id>.jsonl,
        // whose path every hook payload carries as transcript_path). Tail that
        // transcript and forward each new assistant text block as a Notification
        // hook event (the same frame the office already renders as a chat bubble),
        // so a VS Code / Claude Code session's live progress shows up in the office
        // — not just its tool calls.
        let transcriptPath: string | null = null;
        let transcriptOffset = 0;
        const seenAsst = new Set<string>();   // assistant-entry uuids already forwarded
        const forwardAssistant = (text: string): void => {
          const msg = text.trim();
          if (!msg || !socket) { return; }
          const ev = buildNotificationEvent(settings.provider || 'claude', cwd, msg.length > 1800 ? msg.slice(0, 1800) + '…' : msg) as Record<string, unknown>;
          ev._session_name = sessionNameForHooks;
          socket.sendFrame({ type: 'hook_event', data: ev });
          markWorking();   // producing assistant text is activity → keep 'working'
        };
        const tailTranscript = (): void => {
          if (!socket || !transcriptPath) { return; }
          try {
            if (!fs.existsSync(transcriptPath)) { return; }
            const size = fs.statSync(transcriptPath).size;
            if (size <= transcriptOffset) { return; }
            const fd = fs.openSync(transcriptPath, 'r');
            const buf = Buffer.alloc(size - transcriptOffset);
            fs.readSync(fd, buf, 0, buf.length, transcriptOffset);
            fs.closeSync(fd);
            transcriptOffset = size;
            for (const line of buf.toString('utf8').split('\n')) {
              const t = line.trim();
              if (!t) { continue; }
              try {
                const d = JSON.parse(t) as { type?: string; uuid?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
                if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) { continue; }
                const uuid = d.uuid || '';
                if (uuid && seenAsst.has(uuid)) { continue; }
                if (uuid) { seenAsst.add(uuid); if (seenAsst.size > 500) { seenAsst.delete(seenAsst.values().next().value as string); } }
                const text = d.message!.content!.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n');
                if (text.trim()) { forwardAssistant(text); }
              } catch { /* skip non-JSON / partial lines */ }
            }
          } catch { /* ignore transient read errors */ }
        };
        // Point the transcript tailer at a session's transcript (from a hook's
        // transcript_path). A SMALL/fresh transcript — e.g. a short autonomy worker
        // that finished writing its prose before the 5s hook-tick even discovered
        // the file — is read from the START so none of its narration is missed. A
        // LARGE ongoing session (a long-lived interactive VS Code session) is read
        // live from the current end, so we don't replay its whole history as a
        // flood of chat bubbles. uuid dedup (seenAsst) covers any overlap.
        const FRESH_TRANSCRIPT_MAX = 512 * 1024;
        const setTranscript = (p: string): void => {
          if (!p || p === transcriptPath) { return; }
          transcriptPath = p;
          try {
            const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
            transcriptOffset = size <= FRESH_TRANSCRIPT_MAX ? 0 : size;
          } catch { transcriptOffset = 0; }
          seenAsst.clear();
        };

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
                // Every hook payload carries the live transcript path — use it to
                // point the narration tailer at the current session.
                const tp = ev['transcript_path'];
                if (typeof tp === 'string' && tp) { setTranscript(tp); }
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
          // Forward any new assistant prose from the session transcript.
          tailTranscript();
        };
        const interval = setInterval(tick, 5_000);
        interval.unref?.();
      };

      // Lifecycle flags — declared before the forwarding/autonomy loops that read
      // `closed` (their async bodies would otherwise hit its temporal dead zone).
      let inflight = 0;
      let closed = false;
      let superseded = false;

      // ── Single-instance-per-workspace guard (one shared socket, no flap) ─────
      // Two bridges for the same slug fight over the office's last-wins slug index:
      // each reconnect re-registers and re-sends agent_online, which the office
      // closes the other for → an infinite connect/disconnect ping-pong that makes
      // the file-browser/git/VNC icons flash. NEWEST wins: every bridge writes its
      // pid to a workspace lock; an older instance that sees a newer LIVE pid own
      // the lock goes DORMANT — drops its presence socket and stops reconnecting —
      // but does NOT exit (it keeps serving its stdio client over the HTTP
      // fallback). Result: exactly one live presence socket, and no fight.
      const lockFile = path.join(cwd, '.autodev', 'mcp-operate.lock');
      try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); fs.writeFileSync(lockFile, String(process.pid), 'utf8'); } catch { /* best effort */ }
      const supersedeTimer = setInterval(() => {
        if (superseded || closed) { return; }
        let owner = 0;
        try { owner = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10) || 0; } catch { return; }
        if (!owner || owner === process.pid) { return; }
        let ownerAlive = false;
        try { process.kill(owner, 0); ownerAlive = true; } catch { /* dead pid */ }
        if (!ownerAlive) { try { fs.writeFileSync(lockFile, String(process.pid), 'utf8'); } catch { /* ignore */ } return; }
        superseded = true;
        logErr(`mcp-operate: a newer bridge (pid ${owner}) owns this workspace — going dormant (dropping presence, no reconnect) to keep ONE shared socket. Process stays alive.`);
        try { socket?.destroy(); } catch { /* ignore */ }
      }, 1500);
      supersedeTimer.unref?.();

      // Kick off presence now, then reconcile it with ACTUAL loop liveness every
      // few seconds so the loop↔bridge split is always driven by runtime state, not
      // a guessed config flag:
      //   • a live loop owns the slug  → yield (close our socket; loop delivers steers)
      //   • no live loop + we're mcp-only → (re)open so presence returns
      // The decision is a pure function of loop liveness (stable while the loop
      // refreshes its lock every ~25s), so it settles instead of oscillating: a
      // grok-respawned bridge that lost the race and opened a socket closes it
      // within one tick once the loop's lock is seen; a loop that dies frees the
      // slug and the bridge re-opens.
      void ensurePresenceSocket();
      const presenceReconcileTimer = setInterval(() => {
        if (closed || opts.socket === false) { return; }
        // `superseded` bridges already dropped their socket and must never re-open.
        if (superseded) { return; }
        if (loopOwnsPresence()) { yieldPresenceToLoop(); }
        else { void ensurePresenceSocket(); }
      }, 4000);
      presenceReconcileTimer.unref?.();

      startHookForwarding();

      // ── Autonomous task execution + A2A over the SAME socket ─────────────────
      // Parity with `autodev start`: the bridge runs the office work loop over the
      // presence socket it already holds. A task/message push (or a periodic
      // safety check) wakes it; it pulls tasks with get_tasks, and for each:
      // start_task → spawn the workspace provider to DO the work with its native
      // tools → complete_task with the result. All office calls go over the WS
      // (callOffice); the provider is a pure worker (no nested office connection),
      // and its file activity forwards via the hook/transcript tailers above.
      // Always on — an mcp-operate agent is a full office citizen, not read-only.
      const startAutonomy = (): void => {
        if (opts.socket === false) { return; }
        const provider = settings.provider || 'claude-cli';
        if (!provider.startsWith('claude')) {
          logErr(`🤖 autonomy: provider '${provider}' is driven by its own supervisor (opencode serve/attach); the bridge auto-runs claude only.`);
          return;
        }
        // The worker runs with an EMPTY strict MCP config so it never loads the
        // workspace's pixel-office MCP (which would open a second, nested bridge).
        // It just edits files; the office bookkeeping is done here over the WS.
        const workerMcp = path.join(cwd, '.autodev', 'auto-worker-mcp.json');
        try {
          fs.mkdirSync(path.dirname(workerMcp), { recursive: true });
          fs.writeFileSync(workerMcp, JSON.stringify({ mcpServers: {} }), 'utf8');
        } catch (e) { logErr('🤖 autonomy: could not write worker MCP config: ' + ((e as Error)?.message ?? String(e))); }

        let working = false;
        let dirty = false;
        let wake: (() => void) | null = null;
        triggerWork = () => { dirty = true; if (wake) { const w = wake; wake = null; w(); } };

        const officeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
          try {
            const r = await callOffice({ id: `auto-${name}-${++wsReqSeq}`, method: 'tools/call', params: { name, arguments: args } });
            return ((r['result'] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? '';
          } catch { return ''; }
        };
        const parsePendingTasks = (text: string): Array<{ id: string; title: string }> => {
          const out: Array<{ id: string; title: string }> = [];
          for (const line of text.split('\n')) {
            const m = line.match(/^[•\-*]\s*\[(pending|in-progress)\]\s*(\S+):\s*(.+)$/);
            if (m) { out.push({ id: m[2], title: m[3].replace(/\s+—\s.*$/, '').trim() }); }
          }
          return out;
        };
        // "- from <slug> (when): <body>" → {from, body}
        const parseMessages = (text: string): Array<{ from: string; body: string }> => {
          const out: Array<{ from: string; body: string }> = [];
          for (const line of text.split('\n')) {
            const m = line.match(/^-\s*from\s+(\S+?)(?:\s*\([^)]*\))?:\s*(.+)$/);
            if (m) { out.push({ from: m[1], body: m[2].trim() }); }
          }
          return out;
        };
        const runWorker = (prompt: string): Promise<string> => new Promise((resolve) => {
          logErr(`🤖 autonomy: working — ${prompt.slice(0, 70).replace(/\n/g, ' ')}…`);
          const child = spawn('claude', ['--dangerously-skip-permissions', '--strict-mcp-config', '--mcp-config', workerMcp, '-p', prompt], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout?.on('data', (b) => { out += b.toString(); });
          child.on('exit', () => resolve(out.trim()));
          child.on('error', (e) => resolve('worker failed: ' + e.message));
        });

        const runCycle = async (): Promise<void> => {
          const pending = parsePendingTasks(await officeTool('get_tasks', { status: 'pending' }));
          for (const t of pending) {
            if (closed) { break; }
            await officeTool('start_task', { task_id: t.id });
            const result = await runWorker(`You are working as the office agent in this workspace. Complete this task using your own tools (edit/create files as needed), then briefly summarize what you did.\n\nTASK: ${t.title}`);
            await officeTool('complete_task', { task_id: t.id, result: (result || 'Done.').slice(0, 1500) });
            logErr(`🤖 autonomy: completed task ${t.id} (${t.title.slice(0, 40)})`);
          }

          // A2A: reply to direct messages (check_messages). The worker composes a
          // reply or decides none is needed (NO_REPLY); capped per cycle and told
          // not to ask questions back, so agent↔agent chatter can't loop forever.
          const messages = parseMessages(await officeTool('check_messages', { unread_only: true }));
          let replied = 0;
          for (const m of messages) {
            if (closed || replied >= 3) { break; }
            const reply = (await runWorker(`A teammate "${m.from}" sent you this message in the office:\n\n"${m.body}"\n\nIf a reply is warranted, output ONLY the reply text — concise, and do NOT ask a question back unless truly essential. If the message needs work in this workspace, do it, then reply with what you did. If no reply is needed, output exactly: NO_REPLY`)).trim();
            if (reply && !/^NO_REPLY/i.test(reply)) {
              await officeTool('send_message', { to: m.from, message: reply.slice(0, 1000) });
              logErr(`🤖 autonomy: replied to ${m.from}`);
              replied++;
            }
          }
        };

        void (async () => {
          logErr('🤖 autonomy: enabled — will execute assigned tasks over the office socket.');
          while (!closed) {
            await new Promise<void>((res) => { wake = res; const timer = setTimeout(() => { if (wake === res) { wake = null; res(); } }, 30_000); timer.unref?.(); });
            if (closed) { break; }
            // A dormant (superseded) bridge must not do office work — the winner does.
            if (working || superseded || !wsReady()) { continue; }
            if (!dirty) {
              // Periodic safety net (covers a missed push): only act on real work.
              const has = parsePendingTasks(await officeTool('get_tasks', { status: 'pending' })).length > 0;
              if (!has) { continue; }
            }
            dirty = false;
            working = true;
            try { await runCycle(); }
            catch (e) { logErr('🤖 autonomy: cycle error — ' + ((e as Error)?.message ?? String(e))); }
            finally { working = false; }
          }
        })();
      };
      startAutonomy();

      // Drain in-flight requests before exiting when stdin closes, so a reply
      // in progress is never clipped. (inflight/closed declared above.)
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

      // ── Single JSON-RPC request path (shared by stdio + HTTP) ────────────────
      // Process ONE inbound MCP message and return the response object to send
      // back, or null for a notification / message with no reply. Both the stdio
      // line reader and the HTTP handler call this, so wait_for_events blocking,
      // tools/list augmentation, and notification forwarding all live in ONE place
      // regardless of transport.
      const dispatch = async (req: { id?: unknown; method?: string; params?: unknown }): Promise<Record<string, unknown> | null> => {
        // Notifications (no id) are one-way — nothing to reply. Forward the
        // handshake ones opportunistically but never return a response for them.
        if (req.id === undefined || req.id === null) {
          if (typeof req.method === 'string' && req.method.startsWith('notifications/')) {
            // Fire-and-forget over the socket when ready, else HTTP.
            if (wsReady()) { socket!.sendFrame({ type: 'operator_request', method: req.method, params: req.params ?? {} }); }
            else { proxy(endpoint, key, req).catch(() => { /* best effort */ }); }
          }
          return null;
        }

        // Local tool: wait_for_events — stream office activity from the socket
        // instead of proxying to the server. Blocks until an event (or timeout).
        const params = req.params as { name?: string; arguments?: { timeout_seconds?: unknown } } | undefined;
        if (req.method === 'tools/call' && params?.name === 'wait_for_events') {
          inflight++;
          try {
            const secs = Math.max(1, Math.min(55, Number(params?.arguments?.timeout_seconds) || 25));
            if (eventQueue.length === 0) { await waitForEvent(secs * 1000); }
            const events = eventQueue.splice(0, eventQueue.length);
            const text = events.length
              ? `Office activity (${events.length} event${events.length === 1 ? '' : 's'}):\n${events.join('\n')}\n\nUse get_events / check_messages for detail, then call wait_for_events again to keep listening.`
              : `No new events in ${secs}s. Call wait_for_events again to keep listening.`;
            return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } };
          } finally { inflight--; maybeExit(); }
        }

        inflight++;
        try {
          const res = await callOffice(req);
          // Advertise the local streaming tool alongside the server's own tools.
          if (req.method === 'tools/list') {
            const result = res['result'] as { tools?: unknown[] } | undefined;
            if (result && Array.isArray(result.tools)) { result.tools.push(WAIT_TOOL); }
          }
          return res;
        } catch (e) {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'proxy error: ' + ((e as Error)?.message ?? String(e)) } };
        } finally {
          inflight--;
          maybeExit();
        }
      };

      // ── Transport: persistent HTTP (Streamable HTTP) OR stdio ────────────────
      // opencode's `type: remote` MCP client (MCP.connectRemote) tries Streamable
      // HTTP first — POST JSON-RPC to the configured `url`, Accept
      // `application/json, text/event-stream` — then falls back to legacy SSE. It
      // also opens a standalone GET SSE stream after `initialized` but TOLERATES a
      // 405 there. So the persistent sidecar needs only: POST → single JSON-RPC
      // reply as `application/json` (202 for notification-only bodies), GET → 405
      // (no server-initiated stream; office activity reaches the model via the
      // wait_for_events tool, exactly as over stdio). This lets ONE always-on
      // bridge serve both `opencode serve` and every `opencode run` with no
      // stdio-spawn dependency and no flap.
      if (opts.httpPort) {
        const httpHost = opts.httpHost || '127.0.0.1';
        const sessionId = crypto.randomUUID();
        const httpServer = http.createServer((hreq, hres) => {
          // No standalone server→client SSE stream: the client tolerates 405 on
          // the GET it opens after `initialized` (if(status===405)return).
          if (hreq.method === 'GET') { hres.writeHead(405, { 'Content-Type': 'text/plain' }); hres.end('Method Not Allowed'); return; }
          // Session teardown — acknowledge and move on (stateless bridge).
          if (hreq.method === 'DELETE') { hres.writeHead(204); hres.end(); return; }
          if (hreq.method !== 'POST') { hres.writeHead(405, { 'Content-Type': 'text/plain' }); hres.end('Method Not Allowed'); return; }
          let body = '';
          hreq.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) { hreq.destroy(); } });
          hreq.on('end', async () => {
            let parsed: unknown;
            try { parsed = JSON.parse(body); } catch {
              hres.writeHead(400, { 'Content-Type': 'application/json' });
              hres.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
              return;
            }
            const batch = Array.isArray(parsed);
            const msgs = (batch ? parsed : [parsed]) as Array<{ id?: unknown; method?: string; params?: unknown }>;
            const isInit = msgs.some((m) => m && m.method === 'initialize');
            const responses: Record<string, unknown>[] = [];
            for (const m of msgs) {
              try { const r = await dispatch(m); if (r) { responses.push(r); } }
              catch (e) {
                if (m && m.id !== undefined && m.id !== null) {
                  responses.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'bridge error: ' + ((e as Error)?.message ?? String(e)) } });
                }
              }
            }
            // Notification/response-only body → 202 Accepted, no content.
            if (responses.length === 0) {
              hres.writeHead(202, isInit ? { 'Mcp-Session-Id': sessionId } : {});
              hres.end();
              return;
            }
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (isInit) { headers['Mcp-Session-Id'] = sessionId; }
            hres.writeHead(200, headers);
            hres.end(JSON.stringify(batch ? responses : responses[0]));
          });
          hreq.on('error', () => { try { hres.writeHead(400); hres.end(); } catch { /* ignore */ } });
        });
        httpServer.on('error', (e) => {
          process.stderr.write(`autodev mcp-operate: HTTP server error — ${e instanceof Error ? e.message : String(e)}\n`);
          process.exit(1);
        });
        httpServer.listen(opts.httpPort, httpHost, () => {
          process.stderr.write(`autodev mcp-operate: persistent Streamable-HTTP MCP listening on http://${httpHost}:${opts.httpPort}/mcp (point an opencode \`type: remote\` MCP at this URL).\n`);
        });
        // No stdin client in HTTP mode — do NOT read/close on stdin (a detached
        // sidecar has stdin closed, which would otherwise trip maybeExit). The
        // HTTP server keeps the process alive.
        rl.close();
      } else {
        rl.on('line', async (line: string) => {
          const t = line.trim();
          if (!t) { return; }
          let req: { id?: unknown; method?: string; params?: unknown };
          try { req = JSON.parse(t); } catch { return; }
          const resp = await dispatch(req);
          if (resp) { send(resp); }
        });
        rl.on('close', () => { closed = true; maybeExit(); });
      }
    });
}
