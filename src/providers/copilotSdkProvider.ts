// ---------------------------------------------------------------------------
// copilotSdkProvider - GitHub Copilot in-process SDK integration.
//
// Uses @github/copilot sdk/index.js (LocalSession) directly - no subprocess,
// no PTY, no hooks file watching.  Auth is read from the Windows Credential
// Manager (via keytar) or from the GITHUB_TOKEN / GH_TOKEN env var.
//
// Completion detection: session.on('session.idle', ...) fires when the agent
// finishes each turn.  The exitFile is written at that point.
//
// Multi-turn: LocalSession persists conversation history.  The same session
// object is reused for all tasks within a workspace root.
// ---------------------------------------------------------------------------

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { appendHookEvent } from '../hookEventNormalizer';
import { LiveNarrationStreamer, appendHookEventLine } from '../core/liveNarration';

// ---------------------------------------------------------------------------
// Minimal runtime types mirroring @github/copilot sdk/index.d.ts
// ---------------------------------------------------------------------------
interface SdkSessionEvent { type: string; data?: Record<string, unknown>; ephemeral?: boolean; }
type SdkEventHandler = (event: SdkSessionEvent) => void;
interface SdkLocalSession {
  on(eventType: string, handler: SdkEventHandler): () => void;
  // mode 'enqueue' (default) queues the prompt for the next turn; 'immediate'
  // injects it into the CURRENTLY-RUNNING turn (true mid-turn steering).
  send(options: { prompt: string; mode?: 'enqueue' | 'immediate' }): Promise<void>;
  dispose(): void;
  respondToPermission(requestId: string, response: { kind: string }): void;
  respondToUserInput(requestId: string, response: { kind: string; text?: string }): void;
}
interface SdkCoreServices {
  featureFlagService?: unknown;
  autoModeManager?: unknown;
  telemetryService?: unknown;
}
interface SdkModule {
  LocalSession: new (coreServices: SdkCoreServices, options: unknown) => SdkLocalSession;
  createCoreServices: (opts: SdkCoreServices) => SdkCoreServices;
}
interface KeytarModule {
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

// ---------------------------------------------------------------------------
// SDK + keytar path resolution
// ---------------------------------------------------------------------------
function _copilotNpmRoot(): string {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@github', 'copilot');
  }
  for (const candidate of [
    '/usr/local/lib/node_modules/@github/copilot',
    '/usr/lib/node_modules/@github/copilot',
    path.join(os.homedir(), '.npm', 'node_modules', '@github', 'copilot'),
  ]) {
    if (fs.existsSync(candidate)) { return candidate; }
  }
  return '/usr/local/lib/node_modules/@github/copilot';
}

function _sdkPath(): string {
  return path.join(_copilotNpmRoot(), 'sdk', 'index.js');
}

function _keytarPath(): string | null {
  const p = path.join(_copilotNpmRoot(), 'prebuilds', process.platform + '-' + process.arch, 'keytar.node');
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Auth loading (cached after first successful load)
// ---------------------------------------------------------------------------
interface AuthInfo {
  type: 'gh-cli';
  host: string;
  login: string;
  token: string;
  copilotUser?: unknown;
}

let _authCache: AuthInfo | undefined;
let _authLoadingPromise: Promise<AuthInfo | undefined> | null = null;

async function _fetchCopilotUser(token: string): Promise<unknown> {
  const res = await fetch('https://api.github.com/copilot_internal/user', {
    headers: { 'Authorization': 'token ' + token, 'User-Agent': 'GitHubCopilotCLI/1.0' },
  });
  if (!res.ok) { throw new Error('HTTP ' + res.status); }
  return res.json();
}

// Settings-derived token set by the extension before each send.
let _settingsToken: string | undefined;
export function setCopilotSettingsToken(token: string | undefined): void {
  _settingsToken = token || undefined;
}

async function _loadAuth(): Promise<AuthInfo | undefined> {
  const envToken =
    _settingsToken ||
    process.env['COPILOT_GITHUB_TOKEN'] ||
    process.env['GITHUB_COPILOT_GITHUB_TOKEN'] ||
    process.env['GH_TOKEN'] ||
    process.env['GITHUB_TOKEN'];

  if (envToken) {
    const copilotUser = await _fetchCopilotUser(envToken).catch(() => undefined);
    return { type: 'gh-cli', host: 'https://github.com', login: 'unknown', token: envToken, copilotUser };
  }

  const kp = _keytarPath();
  if (kp) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const keytar = require(kp) as KeytarModule;
      const creds = await keytar.findCredentials('copilot-cli');
      if (creds.length > 0) {
        const { account, password: token } = creds[0];
        const loginMatch = account.match(/:([^:]+)$/);
        const login = loginMatch ? loginMatch[1] : 'unknown';
        const copilotUser = await _fetchCopilotUser(token).catch(() => undefined);
        return { type: 'gh-cli', host: 'https://github.com', login, token, copilotUser };
      }
    } catch { /* keytar unavailable */ }
  }

  return undefined;
}

function _getAuth(): Promise<AuthInfo | undefined> {
  if (_authCache) { return Promise.resolve(_authCache); }
  if (!_authLoadingPromise) {
    _authLoadingPromise = _loadAuth().then(a => {
      _authCache = a;
      _authLoadingPromise = null;
      return a;
    });
  }
  return _authLoadingPromise;
}

export function clearCopilotAuthCache(): void {
  _authCache = undefined;
  _authLoadingPromise = null;
}

/** Expose the npm root path so callers can run `npm rebuild` there. */
export function copilotNpmRoot(): string {
  return _copilotNpmRoot();
}

/** Clear the cached SDK dynamic import so the next call to _getSdk() re-imports it. */
export function clearCopilotSdkCache(): void {
  _sdkPromise = null;
}

// ---------------------------------------------------------------------------
// SDK module loading (cached after first import)
// ---------------------------------------------------------------------------
let _sdkPromise: Promise<SdkModule> | null = null;

function _getSdk(): Promise<SdkModule> {
  if (!_sdkPromise) {
    const p = _sdkPath();
    const url = p.startsWith('/') ? 'file://' + p : 'file:///' + p.replace(/\\/g, '/');
    // Use Function() wrapper to prevent esbuild from transforming import() â†’ require().
    // require() does not support file:// URLs; real dynamic import() does.
    _sdkPromise = ((Function('u', 'return import(u)')(url)) as Promise<SdkModule>).catch(e => {
      _sdkPromise = null;
      throw new Error('Failed to load Copilot SDK from ' + p + ': ' + (e?.message ?? e));
    });
  }
  return _sdkPromise;
}

// ---------------------------------------------------------------------------
// Per-workspace state
// ---------------------------------------------------------------------------
interface CopilotSdkState {
  session:    SdkLocalSession;
  stdoutFile: string | null;
  exitFile:   string | null;
  log:        ((msg: string) => void) | null;
  offIdle:    (() => void) | null;
  deltasSeen: boolean;
  /** Set when session.error fires — next idle should dispose & fail the task */
  sessionErrored: boolean;
  /** Coalesces streamed assistant text into live `Notification` hook events. */
  narrator:   LiveNarrationStreamer | null;
}

const _sessions  = new Map<string, CopilotSdkState>();
const _busyRoots = new Set<string>();

// ---------------------------------------------------------------------------
// Public interface (same shape as the old PTY-based provider)
// ---------------------------------------------------------------------------

export function isCopilotSdkBusy(root: string): boolean {
  return _busyRoots.has(root);
}

export function getLatestCopilotSdkSessionId(root: string): string | undefined {
  return _sessions.has(root) ? 'copilot-sdk:' + path.basename(root) : undefined;
}

/**
 * Steer the live Copilot SDK session MID-TURN. Unlike copilot-cli (a one-shot
 * subprocess), the SDK holds a persistent LocalSession whose send() accepts
 * mode:'immediate' — the message is injected into the CURRENTLY-RUNNING turn
 * (the model's next call includes it) instead of the default 'enqueue' which
 * waits for the next turn. Returns true only if there's a live/busy session to
 * inject into; false otherwise, so the caller falls back to the durable TODO
 * queue (at-least-once delivery preserved).
 */
export async function steerCopilotSdk(root: string, text: string, log: (msg: string) => void): Promise<boolean> {
  const state = _sessions.get(root);
  if (!state || !_busyRoots.has(root)) { return false; }
  try {
    await state.session.send({ prompt: text, mode: 'immediate' });
    log('Copilot SDK: steered mid-turn (' + text.length + ' chars) — injected into current turn');
    return true;
  } catch (e) {
    log('Copilot SDK: mid-turn steer failed: ' + ((e as Error)?.message ?? String(e)));
    return false;
  }
}

export function readCopilotSdkOutputSince(stdoutFile: string, fromByte: number): string {
  try {
    const raw = fs.readFileSync(stdoutFile, 'utf8');
    return fromByte > 0 ? raw.slice(fromByte) : raw;
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// sendCopilotSdkPrompt - fire-and-forget entry point
// ---------------------------------------------------------------------------

export function sendCopilotSdkPrompt(
  root: string,
  promptFilePath: string,
  _resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  showOutput?: () => void,
): void {
  showOutput?.();
  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  _busyRoots.add(root);

  _sendAsync(root, promptFilePath, stdoutFile, exitFile, log).catch(e => {
    log('Copilot SDK error: ' + (e?.message ?? String(e)));
    _busyRoots.delete(root);
    try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Core async implementation
// ---------------------------------------------------------------------------

async function _sendAsync(
  root: string,
  promptFilePath: string,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
): Promise<void> {
  let promptText: string;
  try {
    promptText = fs.readFileSync(promptFilePath, 'utf8');
  } catch (e) {
    throw new Error('Cannot read prompt file ' + promptFilePath + ': ' + (e as Error).message);
  }

  const [authInfo, sdk] = await Promise.all([_getAuth(), _getSdk()]);
  if (!authInfo) {
    throw new Error(
      'No GitHub Copilot credentials found. ' +
      'Set the GITHUB_TOKEN env var or run copilot auth login.',
    );
  }

  let state = _sessions.get(root);
  if (!state) {
    log('Copilot SDK: creating LocalSession for ' + path.basename(root));
    // SDK v1.0.48+ constructor is (coreServices, options) — two args.
    // Passing everything as one arg puts authInfo in the coreServices slot
    // where it is ignored, so this.authInfo is never set â†’ session.error.
    const coreServices = sdk.createCoreServices ? sdk.createCoreServices({}) : {};
    // Pass permissionRequestHandler in the constructor options so it is stored as
    // this.permissionRequestHandler on the session.  The agent loop checks it BEFORE
    // routing through the PermissionService (which has a path-manager check that
    // returns "user-not-available" / denied when permissionRequestEventsEnabled=false).
    // This is the only reliable way to auto-approve all tool permissions in headless mode.
    const session = new sdk.LocalSession(coreServices, {
      authInfo,
      workingDirectory: root,
      runningInInteractiveMode: false,
      askUserDisabled: true,
      permissionRequestHandler: async (_req: unknown) => ({ kind: 'approved' as const }),
    } as unknown as Record<string, unknown>);

    state = { session, stdoutFile: null, exitFile: null, log: null, offIdle: null, deltasSeen: false, sessionErrored: false, narrator: null };
    _sessions.set(root, state);

    // Wire up output streaming to stdoutFile (registered once per session)
    const localState = state;
    const hooksJsonlDir = path.join(root, '.autodev');
    const hooksJsonlPath = path.join(hooksJsonlDir, 'hooks-events.jsonl');
    log('Copilot SDK: hooks-events.jsonl â†’ ' + hooksJsonlPath);
    session.on('*', (ev: SdkSessionEvent) => {
      // Auto-approve all permission requests (yolo / allow-all mode)
      if (ev.type === 'permission.requested' && ev.data?.['requestId']) {
        try { session.respondToPermission(ev.data['requestId'] as string, { kind: 'approved' }); } catch { /* ignore */ }
      }
      // Auto-respond to user_input requests
      if (ev.type === 'user_input.requested' && ev.data?.['requestId']) {
        try { session.respondToUserInput(ev.data['requestId'] as string, { kind: 'accept', text: '' }); } catch { /* ignore */ }
      }
      if (!ev.ephemeral) {
        const d = ev.data ?? {};
        const toolName = (d['toolName'] ?? d['name']) as string | undefined;
        const extra = (ev.type === 'tool.execution_start' || ev.type === 'tool.execution_complete')
          ? ' [' + (toolName ?? '?') + ']'
          : '';
        localState.log?.('Copilot SDK [event]: ' + ev.type + extra);
        // Track session errors so the next idle disposes the broken session
        if (ev.type === 'session.error') {
          localState.sessionErrored = true;
          localState.log?.('Copilot SDK: session.error — will dispose session on next idle');
        }
        // Skip the final full-text AgentMessage when we already streamed the same
        // text live via delta-driven Notification events (below) — otherwise the
        // chat shows the whole message a second time as one big trailing bubble.
        const isStreamedAssistantMessage = ev.type === 'assistant.message' && localState.deltasSeen;
        if (!isStreamedAssistantMessage) {
          appendHookEvent(
            hooksJsonlPath, 'copilot-sdk',
            ev as unknown as Record<string, unknown>,
            fs, path,
            (e) => localState.log?.('Copilot SDK [hooks write error]: ' + String(e)),
          );
        }
      }
      if (!localState.stdoutFile) { return; }
      if (ev.type === 'assistant.turn_start') {
        localState.deltasSeen = false;
      } else if (ev.type === 'assistant.message_delta') {
        const chunk = ev.data?.['deltaContent'] as string | undefined;
        if (chunk) {
          localState.deltasSeen = true;
          try { fs.appendFileSync(localState.stdoutFile, chunk, 'utf8'); } catch { /* ignore */ }
          // Stream the assistant's text to the chat live (coalesced Notifications).
          localState.narrator?.push(chunk);
        }
      } else if (ev.type === 'assistant.message' && !localState.deltasSeen) {
        const content = ev.data?.['content'] as string | undefined;
        if (content) {
          try { fs.appendFileSync(localState.stdoutFile, content + '\n', 'utf8'); } catch { /* ignore */ }
        }
      }
    });
  }

  // Detach any leftover idle handler from a previous task
  state.offIdle?.();
  state.offIdle    = null;
  state.deltasSeen = false;

  // Reset per-task error flag
  state.sessionErrored = false;

  state.stdoutFile = stdoutFile;
  state.exitFile   = exitFile;
  state.log        = log;
  // Fresh per-task narrator: streams this turn's assistant text to the chat live.
  state.narrator?.dispose();
  state.narrator = new LiveNarrationStreamer('copilot-sdk', root, ev => appendHookEventLine(root, ev));

  // Completion helper — safe to call multiple times (no-ops after first call)
  let completionFired = false;
  let offIdleHandle: (() => void) | null = null;
  let offTaskComplete: (() => void) | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const _complete = (reason: string, exitCode = 0) => {
    if (completionFired) { return; }
    completionFired = true;
    offIdleHandle?.();   offIdleHandle = null;
    offTaskComplete?.(); offTaskComplete = null;
    if (timeoutHandle !== null) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    // Flush any assistant text still buffered so the turn's final words reach the chat.
    state!.narrator?.flush();
    state!.narrator = null;
    log('Copilot SDK: task complete (' + reason + ')');
    const ef = state!.exitFile;
    state!.exitFile   = null;
    state!.stdoutFile = null;
    state!.log        = null;
    _busyRoots.delete(root);
    if (ef) { try { fs.writeFileSync(ef, exitCode + '\n', 'utf8'); } catch { /* ignore */ } }
  };

  // 3-minute timeout: dispose the stuck session so the next task gets a fresh one
  timeoutHandle = setTimeout(() => {
    log('Copilot SDK: timeout (3min) — disposing stuck session');
    completionFired = true;
    offIdleHandle?.();   offIdleHandle = null;
    offTaskComplete?.(); offTaskComplete = null;
    state!.narrator?.flush();
    state!.narrator = null;
    // Dispose the session (it's stuck on a tool execution — can't recover)
    const s = _sessions.get(root);
    if (s) {
      try { s.session.dispose(); } catch { /* ignore */ }
      _sessions.delete(root);
    }
    _busyRoots.delete(root);
    const ef = state!.exitFile;
    state!.exitFile = null; state!.stdoutFile = null; state!.log = null;
    if (ef) { try { fs.writeFileSync(ef, '1\n', 'utf8'); } catch { /* ignore */ } }
  }, 3 * 60 * 1000);

  // session.idle fires when the agent finishes a turn
  offIdleHandle = state.session.on('session.idle', () => {
    if (state!.sessionErrored) {
      log('Copilot SDK: session.idle after error — disposing broken session');
      // Dispose so the next task creates a fresh session
      const s = _sessions.get(root);
      if (s) {
        try { s.session.dispose(); } catch { /* ignore */ }
        _sessions.delete(root);
      }
      _complete('session.error', 1);
    } else {
      log('Copilot SDK: session.idle fired');
      _complete('session.idle');
    }
  });
  // session.task_complete is an additional completion signal
  offTaskComplete = state.session.on('session.task_complete', () => {
    log('Copilot SDK: session.task_complete fired');
    _complete('session.task_complete');
  });
  state.offIdle = () => { completionFired = true; offIdleHandle?.(); offIdleHandle = null; offTaskComplete?.(); offTaskComplete = null; };

  log('Copilot SDK: sending prompt (' + promptText.length + ' chars)');
  await state.session.send({ prompt: promptText });
  // send() resolves when the prompt is submitted, not when the agent finishes.
  // Do NOT call _complete here — the session is still executing. Wait for
  // session.idle (or the 3-minute timeout) so the loop doesn't proceed while
  // the agent is still making tool calls and editing TODO.md.
  log('Copilot SDK: send() resolved — waiting for session.idle');
}

// ---------------------------------------------------------------------------
// Close helpers
// ---------------------------------------------------------------------------

export function closeCopilotSdkSession(root: string, log: (msg: string) => void): void {
  const s = _sessions.get(root);
  if (s) {
    log('Copilot SDK: disposing session');
    s.offIdle?.();
    s.narrator?.dispose();
    try { s.session.dispose(); } catch { /* ignore */ }
    _sessions.delete(root);
    _busyRoots.delete(root);
  }
}

export function closeAllCopilotSdkSessions(): void {
  for (const [root, s] of _sessions) {
    s.offIdle?.();
    s.narrator?.dispose();
    try { s.session.dispose(); } catch { /* ignore */ }
    _sessions.delete(root);
  }
  _busyRoots.clear();
}
