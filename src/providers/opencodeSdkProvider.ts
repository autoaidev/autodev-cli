// ---------------------------------------------------------------------------
// opencodeSdkProvider -- long-running OpenCode session via @opencode-ai/sdk.
//
// Uses createOpencode() to start the OpenCode server in-process and keeps it
// alive per workspace root.  Each task calls session.promptAsync() and
// iterates the global event stream to collect streaming output, completing
// when session.idle fires for the active session.
//
// No terminal is spawned -- all I/O goes through the extension-host process.
// Mirrors the claude-tui provider pattern.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { pathToFileURL } from 'url';
import { normalizeEvent } from '../hookEventNormalizer';

// ---------------------------------------------------------------------------
// Minimal TypeScript interfaces for the parts of the SDK we use.
// The module is imported dynamically at runtime so we stay loosely coupled
// and avoid module-system issues with the ESM-only SDK package.
// ---------------------------------------------------------------------------

interface TextPart { type: 'text'; text: string; }
interface ModelSpec { providerID: string; modelID: string; }

interface SdkSession {
  create(opts: { query?: { directory?: string }; body?: { title?: string } }): Promise<{ data: { id: string } }>;
  promptAsync(opts: { path: { id: string }; body: { parts: TextPart[]; model?: ModelSpec } }): Promise<unknown>;
  abort(opts: { path: { id: string } }): Promise<unknown>;
  postSessionIdPermissionsPermissionId(opts: { path: { id: string; permissionID: string }; body?: { response: 'once' | 'always' | 'reject' } }): Promise<unknown>;
}

interface SdkGlobal {
  event(opts?: Record<string, unknown>): Promise<{ stream: AsyncGenerator<unknown> }>;
}

interface SdkClient {
  session: SdkSession;
  global: SdkGlobal;
}

interface SdkServer { url: string; close(): void; }

interface SdkModule {
  createOpencode(opts?: Record<string, unknown>): Promise<{ client: SdkClient; server: SdkServer }>;
}

// ---------------------------------------------------------------------------
// Per-workspace persistent state.
// ---------------------------------------------------------------------------

interface SdkState {
  client: SdkClient;
  server: SdkServer;
  sessionId: string;
}

const _state = new Map<string, SdkState>();
const _latestSessionIds = new Map<string, string>();
/** Latest log function per root — updated every dispatch so the background logger always writes to the active channel. */
const _loggers = new Map<string, (msg: string) => void>();
/** Current tool activity per root — set from tool.execute.before events, cleared on idle. */
const _activity = new Map<string, string>();

/** Roots that currently have an opencode-sdk turn actively running. */
const _busyRoots = new Set<string>();

/** True while an opencode-sdk turn is running for the given workspace root. */
export function isOpencodeSdkBusy(root: string): boolean {
  return _busyRoots.has(root);
}

/** Current tool activity label for the given root (undefined = idle). */
export function getOpencodeSdkActivity(root: string): string | undefined {
  return _activity.get(root);
}

export function getOpencodeSdkLatestSessionId(root: string): string | undefined {
  return _latestSessionIds.get(root) ?? _state.get(root)?.sessionId;
}

// ---------------------------------------------------------------------------
// Lazy SDK loader — uses dynamic import() so esbuild resolves the ESM-only
// package using its "import" export condition at bundle time.
// ---------------------------------------------------------------------------

let _sdkCache: SdkModule | null = null;

// Walk up from __dirname to find @opencode-ai/sdk/dist/index.js.
// We import by absolute path to bypass the exports map resolution entirely —
// bare specifier import('@opencode-ai/sdk') uses CJS resolution in a CJS bundle
// and fails because the package only defines an "import" condition (no "require").
function _findSdkEntryPath(): string {
  let dir = __dirname;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, 'node_modules', '@opencode-ai', 'sdk', 'dist', 'index.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('@opencode-ai/sdk not found in any node_modules above ' + __dirname);
    }
    dir = parent;
  }
}

// Use new Function() to prevent esbuild from transforming import(path) to require(path).
// require() cannot load ESM files; a native ESM import() is required.
const _dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<unknown>;

async function _getSdk(): Promise<SdkModule> {
  if (!_sdkCache) {
    const sdkPath = _findSdkEntryPath();
    // pathToFileURL handles Windows drive-letter paths (e.g. H:\...) which
    // Node's ESM loader rejects as unknown URL schemes unless converted to file://
    const sdkUrl = pathToFileURL(sdkPath).href;
    _sdkCache = (await _dynamicImport(sdkUrl)) as unknown as SdkModule;
  }
  return _sdkCache;
}

// ---------------------------------------------------------------------------
// Free-port finder — tries ports starting at BASE_PORT, increments until one
// is not bound, so multiple VS Code instances on the same machine each get
// their own port.
// ---------------------------------------------------------------------------

const BASE_PORT = 4096;
const MAX_PORT  = 4200;

function isFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(): Promise<number> {
  for (let p = BASE_PORT; p <= MAX_PORT; p++) {
    if (await isFree(p)) { return p; }
  }
  return 0; // let the OS pick if everything in range is busy
}

/** Returns the cached state for this root, or starts a fresh server + session. */
async function getOrCreate(
  root: string,
  resumeSessionId: string | undefined,
  log: (msg: string) => void,
): Promise<SdkState> {
  const existing = _state.get(root);
  if (existing) {
    _loggers.set(root, log); // refresh in case output channel changed
    log(`OpenCode SDK: reusing live session (session=${existing.sessionId})`);
    return existing;
  }

  log('OpenCode SDK: starting server…');
  const sdk = await _getSdk();
  const port = await findFreePort();
  log(`OpenCode SDK: using port ${port}`);
  const { client, server } = await sdk.createOpencode(port ? { port } : {});
  log(`OpenCode SDK: server ready at ${server.url}`);

  let sessionId: string;
  if (resumeSessionId) {
    sessionId = resumeSessionId;
    log(`OpenCode SDK: resuming session ${sessionId}`);
  } else {
    const res = await client.session.create({ query: { directory: root } });
    sessionId = res.data.id;
    log(`OpenCode SDK: created session ${sessionId}`);
  }

  const st: SdkState = { client, server, sessionId };
  _state.set(root, st);
  _latestSessionIds.set(root, sessionId);
  // Start the persistent background event logger for this root.
  void _startEventLogger(root, client);
  return st;
}

// ---------------------------------------------------------------------------
// Background event logger — one persistent SSE connection per workspace root.
// Logs all events (except message.part.updated which is streamed as text)
// to the VS Code output channel via the stored logger for that root.
// ---------------------------------------------------------------------------

// Noisy / high-frequency / no-payload events that are NOT forwarded to
// pixel-office. Mirrors the skip set of the opencode-cli hooks plugin so the
// SDK and CLI provider emit the same event stream. `message.part.delta` is
// handled explicitly below (buffered into assistant text), not skipped here.
const _SKIP_LOG = new Set([
  'message.part.updated', 'message.part.removed', 'message.updated', 'message.removed',
  'session.diff', 'sync', 'server.heartbeat',
  'session.next.step.started', 'session.next.reasoning.started', 'session.next.text.started',
  'session.next.tool.input.started', 'session.next.tool.input.ended',
  'session.next.tool.called', 'session.next.tool.success',
]);

/** Accumulated assistant text per root — flushed to the output channel on session.idle. */
const _textBuffer = new Map<string, string>();

// ---------------------------------------------------------------------------
// JSONL sink — normalizes raw SDK events to the unified hook schema and
// appends them to <root>/.autodev/hooks-events.jsonl for the WS poller.
// ---------------------------------------------------------------------------

function _appendHookEvent(root: string, rawEv: Record<string, unknown>): void {
  try {
    const normalized = normalizeEvent('opencode-sdk', rawEv);
    if (!normalized) { return; }
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(normalized) + '\n', 'utf8');
  } catch { /* ignore write errors — non-critical */ }
}

async function _startEventLogger(root: string, client: SdkClient): Promise<void> {
  try {
    const evResult = await client.global.event();
    for await (const raw of evResult.stream) {
      // Stop if this client is no longer the active one (eviction / close).
      if (_state.get(root)?.client !== client) { break; }
      const logger = _loggers.get(root);
      if (!logger) { break; }

      const ev = raw as Record<string, unknown>;
      const payload = (ev?.payload ?? ev) as Record<string, unknown>;
      const type = payload?.type as string | undefined;
      const props = payload?.properties as Record<string, unknown> | undefined;

      if (!type || _SKIP_LOG.has(type)) { continue; }

      // --- Stream text deltas into a per-root buffer ---
      if (type === 'message.part.delta') {
        const field = props?.field as string | undefined;
        if (field === 'text') {
          const delta = props?.delta as string | undefined;
          if (delta) {
            _textBuffer.set(root, (_textBuffer.get(root) ?? '') + delta);
          }
        }
        continue;
      }

      const st = _state.get(root);

      // --- Permission auto-approval ---
      if (type === 'permission.updated') {
        const perm = props as Record<string, unknown> | undefined;
        const permId = perm?.id as string | undefined;
        const permSid = perm?.sessionID as string | undefined;
        const permTitle = perm?.title as string | undefined;
        if (permId && permSid && st) {
          logger(`[OC] permission.updated — auto-approving: ${permTitle ?? permId}`);
          try {
            await st.client.session.postSessionIdPermissionsPermissionId({
              path: { id: permSid, permissionID: permId },
              body: { response: 'always' },
            });
            logger(`[OC] permission approved (always): ${permTitle ?? permId}`);
          } catch (e) {
            logger(`[OC] permission approval failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        _appendHookEvent(root, {
          type:       'permission.updated',
          payload:    { type: 'permission.updated', properties: { id: permId, sessionID: permSid, title: permTitle } },
        });
        continue; // already logged above
      }

      // --- Activity tracking + JSONL hook events ---
      if (type === 'tool.execute.before') {
        const toolName = (props?.toolID ?? props?.name ?? props?.tool) as string | undefined;
        if (toolName) {
          _activity.set(root, `${toolName}`);
          logger(`[OC] ▶ tool: ${toolName}`);
        }
        _appendHookEvent(root, { payload: { type: 'tool.execute.before', properties: props ?? {} } });
        continue;
      }
      if (type === 'tool.execute.after') {
        const toolName = (props?.toolID ?? props?.name ?? props?.tool) as string | undefined;
        _activity.delete(root);
        logger(`[OC] ✓ tool done: ${toolName ?? '?'}`);
        const rawOut = props?.output ?? props?.result ?? props?.text;
        const outText = typeof rawOut === 'string' ? rawOut.slice(0, 400) : null;
        _appendHookEvent(root, { payload: { type: 'tool.execute.after', properties: props ?? {} } });
        continue;
      }

      // --- Session status / retry ---
      if (type === 'session.status') {
        const status = props as Record<string, unknown> | undefined;
        const statusType = status?.type as string | undefined;
        if (statusType === 'retry') {
          logger(`[OC] ↻ retry (attempt ${status?.attempt ?? '?'}): ${status?.message ?? ''}`);
        } else {
          logger(`[OC] session.status: ${statusType ?? JSON.stringify(status)}`);
        }
        _appendHookEvent(root, { payload: { type: 'session.status', properties: props ?? {} } });
        continue;
      }

      // --- Session compacted ---
      if (type === 'session.compacted') {
        logger(`[OC] 🗜 session compacted`);
        _appendHookEvent(root, { payload: { type: 'session.compacted', properties: props ?? {} } });
        continue;
      }

      // --- Session idle: flush buffered assistant text + clear activity ---
      if (type === 'session.idle') {
        _activity.delete(root);
        const text = _textBuffer.get(root);
        _textBuffer.delete(root);
        if (text?.trim()) {
          // Print a divider then the full assistant response
          logger(`[OC] ── Assistant ──────────────────────────`);
          for (const line of text.split('\n')) { logger(line); }
          logger(`[OC] ────────────────────────────────────────`);
          // Emit as hook event so Pixel Office can display the full message text
          _appendHookEvent(root, { payload: { type: 'session.idle', properties: { ...(props ?? {}), _assistantText: text.slice(0, 3000) } } });
          // Also emit Stop so pixel-office knows the turn ended
          _appendHookEvent(root, { payload: { type: 'session.idle', properties: props ?? {} } });
        } else {
          logger(`[OC] session.idle`);
          _appendHookEvent(root, { payload: { type: 'session.idle', properties: props ?? {} } });
        }
        continue;
      }

      // --- Default: log + forward every non-noisy event to the JSONL sink so
      // pixel-office receives the full event stream (parity with the opencode-cli
      // hooks plugin). Previously only session.error was forwarded here, so
      // lifecycle/file/message events from the SDK never reached the server. ---
      const propsStr = props ? JSON.stringify(props) : '{}';
      logger(`[OC] ${type} ${propsStr}`);
      _appendHookEvent(root, { payload: { type, properties: props ?? {} } });
    }
  } catch { /* server closed or client evicted — exit silently */ }
}

/** Kill and remove a stale server so the next call starts fresh. */
function _evictClient(root: string): void {
  const s = _state.get(root);
  if (s) {
    try { s.server.close(); } catch { /* ignore */ }
    _state.delete(root);
    _loggers.delete(root);
    _textBuffer.delete(root);
  }
}

// ---------------------------------------------------------------------------
// sendOpencodeSdkPrompt
//
// Fire-and-forget: reads the combined prompt file, dispatches it to the
// persistent SDK session, streams output to stdoutFile + log(), writes the
// exit code to exitFile once session.idle fires.
// ---------------------------------------------------------------------------

export function sendOpencodeSdkPrompt(
  root: string,
  /** Absolute path to the combined agent-profile + message file. */
  promptFilePath: string,
  resumeSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  /** Optional model string "providerID/modelID" */
  model?: string,
  /** Optional callback invoked once to reveal the output panel to the user. */
  showOutput?: () => void,
): void {
  showOutput?.();

  // Keep the background event logger pointed at the freshest log function.
  _loggers.set(root, log);

  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  void (async () => {
    _busyRoots.add(root);
    try {
      const promptText = fs.readFileSync(promptFilePath, 'utf8');
      const { client, sessionId } = await getOrCreate(root, resumeSessionId, log);

      // Parse optional model "providerID/modelID"
      let modelSpec: ModelSpec | undefined;
      if (model) {
        const slash = model.indexOf('/');
        if (slash > 0) {
          modelSpec = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
        }
      }

      log(`OpenCode SDK: sending prompt to session ${sessionId} (${promptText.length} chars)`);

      // Subscribe to events BEFORE sending the prompt so we don't miss early events.
      const evResult = await client.global.event();
      const evStream = evResult.stream;

      // Fire-and-forget prompt — response arrives via event stream.
      const promptPromise = client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: promptText }],
          ...(modelSpec ? { model: modelSpec } : {}),
        },
      });

      // Drain the event stream until session.idle for this session.
      const deadline = Date.now() + 30 * 60_000; // 30-minute safety cap
      let _lineBuf = '';

      for await (const raw of evStream) {
        if (Date.now() > deadline) {
          log('OpenCode SDK: ⚠ 30-minute deadline exceeded — stopping event stream');
          break;
        }

        // GlobalEvent shape: { directory: string; payload: Event }
        const ev = raw as Record<string, unknown>;
        const payload = (ev?.payload ?? ev) as Record<string, unknown>;
        const type = payload?.type as string | undefined;
        const props = payload?.properties as Record<string, unknown> | undefined;

        if (type === 'message.part.updated') {
          const delta = (props?.delta as string | undefined) ?? '';
          if (delta) {
            try { fs.appendFileSync(stdoutFile, delta, 'utf8'); } catch { /* ignore */ }
            _lineBuf += delta;
            let nl: number;
            while ((nl = _lineBuf.indexOf('\n')) !== -1) {
              const line = _lineBuf.slice(0, nl).replace(/\r$/, '');
              _lineBuf = _lineBuf.slice(nl + 1);
              if (line) { log(`  ${line}`); }
            }
          }
        } else if (type === 'session.idle') {
          // Accept the event if its sessionID matches ours, OR if the event
          // doesn't carry a sessionID at all (some SDK versions omit it on
          // single-session servers — safe to assume it's ours).
          const idleSid = (props?.sessionID ?? props?.id) as string | undefined;
          if (!idleSid || idleSid === sessionId) {
            log('OpenCode SDK: session.idle — turn complete');
            break;
          }
        } else if (type === 'session.error') {
          const sid = props?.sessionID as string | undefined;
          if (!sid || sid === sessionId) {
            const errObj = props?.error as Record<string, unknown> | undefined;
            const errMsg = String(errObj?.message ?? errObj ?? 'unknown error');
            log(`OpenCode SDK: session.error — ${errMsg}`);
            try { fs.appendFileSync(stdoutFile, `\n[ERROR] ${errMsg}\n`, 'utf8'); } catch { /* ignore */ }
            break;
          }
        } else if (type === 'server.instance.disposed') {
          // Server is shutting down — abort the wait and evict the stale client
          // so the next dispatch starts a fresh server instance.
          log('OpenCode SDK: server.instance.disposed — aborting wait');
          _evictClient(root);
          try { fs.appendFileSync(stdoutFile, `\n[server disposed]\n`, 'utf8'); } catch { /* ignore */ }
          break;
        }
      }

      // Flush any remaining partial line.
      if (_lineBuf.trim()) { log(`  ${_lineBuf}`); }

      // Await the promptAsync call (should have resolved long ago).
      try { await promptPromise; } catch { /* errors surfaced via session.error event */ }

      _latestSessionIds.set(root, sessionId);
      log('OpenCode SDK: prompt complete');
      try { fs.writeFileSync(exitFile, '0\n', 'utf8'); } catch { /* ignore */ }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`OpenCode SDK: error — ${msg}`);
      try { fs.appendFileSync(stdoutFile, `\n[ERROR] ${msg}\n`, 'utf8'); } catch { /* ignore */ }
      try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
      // Evict the stale state so the next call starts fresh.
      _evictClient(root);
    } finally {
      _busyRoots.delete(root);
      _activity.delete(root);
    }
  })();
}

// ---------------------------------------------------------------------------
// Compact (summarise) the active session to free context window space.
// ---------------------------------------------------------------------------

export function runOpencodeSdkCompact(
  root: string,
  log: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const s = _state.get(root);
    if (!s) { resolve(); return; }
    const { client, sessionId } = s;
    log(`OpenCode SDK: requesting /compact for session ${sessionId}`);
    client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: '/compact' }] },
    }).then(() => resolve()).catch(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Shutdown — cleanly close the server when the task loop stops.
// ---------------------------------------------------------------------------

export function closeOpencodeSdkClient(root: string, log: (msg: string) => void): void {
  const s = _state.get(root);
  if (s) {
    log('OpenCode SDK: closing persistent session + server');
    try { s.server.close(); } catch { /* ignore */ }
    _state.delete(root);
    _loggers.delete(root);
    _activity.delete(root);
    _textBuffer.delete(root);
  }
}

/**
 * Force-clear the busy flag for a root — used by the task loop when it detects
 * via hooks-events.jsonl that the server was disposed while the SDK async was
 * still running (i.e. the for-await loop never received the disposed event).
 */
export function forceIdleOpencodeSdk(root: string): void {
  _busyRoots.delete(root);
  _activity.delete(root);
  _evictClient(root);
}

/** Close all open SDK servers — called on extension deactivate to avoid orphaned processes. */
export function closeAllOpencodeSdkClients(): void {
  for (const [root, s] of _state) {
    try { s.server.close(); } catch { /* ignore */ }
    _state.delete(root);
    _loggers.delete(root);
    _activity.delete(root);
    _textBuffer.delete(root);
    _busyRoots.delete(root);
  }
}
