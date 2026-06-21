// ---------------------------------------------------------------------------
// claudeTuiProvider -- long-running TUI session via @raylin01/claude-client.
//
// Uses ClaudeClient.init() (StructuredClaudeClient) to keep a single Claude
// process alive per workspace root.  Each task calls client.send(text) and
// iterates turn.updates() to stream output to the AutoDev output channel.
//
// No terminal is spawned -- all I/O goes through the extension-host process.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { RateLimitDetector } from '../rateLimit';

// ---------------------------------------------------------------------------
// Minimal TypeScript interfaces for the parts of the library we use.
// The library is require()'d at runtime so we stay loosely coupled.
// ---------------------------------------------------------------------------
interface OpenRequest { id: string; kind: string; }

interface TurnSnapshot {
  text: string;
  status: string;
  openRequests: OpenRequest[];
  result?: { subtype?: string; isError?: boolean; error?: string };
}

interface TurnUpdate { kind: string; snapshot: TurnSnapshot; }

interface TurnHandle {
  updates(): AsyncGenerator<TurnUpdate>;
  done: Promise<TurnSnapshot>;
}

interface RawClient { kill(): void; process: unknown; }

interface StructuredClient {
  sessionId: string | undefined;
  send(text: string): TurnHandle;
  approveRequest(id: string): Promise<void>;
  answerQuestion(id: string, answers: Record<string, unknown>): Promise<void>;
  readonly raw: RawClient;
}

interface LibModule {
  ClaudeClient: {
    init(cfg: Record<string, unknown>): Promise<StructuredClient>;
  };
}

// ---------------------------------------------------------------------------
// Per-workspace persistent client instances.
// ---------------------------------------------------------------------------
const _clients = new Map<string, StructuredClient>();
const _latestSessionIds = new Map<string, string>();

/** Roots that currently have a claude-tui turn actively running (fire-and-forget async in flight). */
const _busyRoots = new Set<string>();

/** Timestamp (ms) of the most recent streaming update received per root. */
const _lastActivityMs = new Map<string, number>();

/** True while a claude-tui turn is running for the given workspace root. */
export function isClaudeTuiBusy(root: string): boolean {
  return _busyRoots.has(root);
}

/** Returns the epoch-ms timestamp of the last streaming update for the root, or 0 if none. */
export function getClaudeTuiLastActivity(root: string): number {
  return _lastActivityMs.get(root) ?? 0;
}

/**
 * Force-clears the busy flag for a root whose turn appears hung
 * (no activity for a long time). Call only after an inactivity timeout.
 */
export function forceIdleClaudeTui(root: string): void {
  _busyRoots.delete(root);
}

export function getClaudeTuiLatestSessionId(root: string): string | undefined {
  return _latestSessionIds.get(root) ?? _clients.get(root)?.sessionId;
}

function _getLib(): LibModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@raylin01/claude-client') as LibModule;
}

/** Returns the cached client, or starts a fresh one (resuming if sessionId given). */
async function getOrCreateClient(
  root: string,
  resumeSessionId: string | undefined,
  log: (msg: string) => void,
  model?: string,
): Promise<StructuredClient> {
  const existing = _clients.get(root);
  if (existing) {
    log(`Claude TUI: reusing live session (session=${existing.sessionId ?? 'unknown'})`);
    return existing;
  }

  const lib = _getLib();
  const client = await lib.ClaudeClient.init({
    cwd: root,
    dangerouslySkipPermissions: true,
    permissionPromptTool: false,    // no --permission-prompt-tool stdio
    verbose: true,
    includePartialMessages: true,
    resumeSessionId: resumeSessionId || undefined,
    env: { CI: 'true' },
    ...(model ? { model: model.replace(/-1m$/i, '') } : {}),
  });

  _clients.set(root, client);
  if (client.sessionId) { _latestSessionIds.set(root, client.sessionId); }
  log(`Claude TUI: client started (session=${client.sessionId ?? 'new'})`);
  return client;
}

/** Kill and remove a stale client so the next call starts fresh. */
function _evictClient(root: string): void {
  const c = _clients.get(root);
  if (c) {
    try { c.raw.kill(); } catch { /* ignore */ }
    _clients.delete(root);
  }
}

/** Cleanly shut down the persistent client when the task loop stops. */
export function closeClaudeTuiClient(root: string, log: (msg: string) => void): void {
  const c = _clients.get(root);
  if (c) {
    log('Claude TUI: closing persistent session');
    try { c.raw.kill(); } catch { /* ignore */ }
    _clients.delete(root);
  }
}

/** Kill all open TUI clients — called on extension deactivate to avoid orphaned processes. */
export function closeAllClaudeTuiClients(): void {
  for (const [root, c] of _clients) {
    try { c.raw.kill(); } catch { /* ignore */ }
    _clients.delete(root);
  }
}

// ---------------------------------------------------------------------------
// sendClaudeTuiPrompt
//
// Fire-and-forget: reads the combined prompt file, sends it to the persistent
// client, streams output to stdoutFile + log(), writes exit code to exitFile.
// ---------------------------------------------------------------------------
export function sendClaudeTuiPrompt(
  root: string,
  /** Absolute path to the combined agent-profile + message file. */
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  /** Optional callback invoked once to reveal the output panel to the user. */
  showOutput?: () => void,
): void {
  showOutput?.();

  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  void (async () => {
    _busyRoots.add(root);
    try {
      const promptText = fs.readFileSync(promptFilePath, 'utf8');

      // Get (or start) the persistent client for this workspace.
      const client = await getOrCreateClient(root, resolvedSessionId, log, model);
      if (client.sessionId) { _latestSessionIds.set(root, client.sessionId); }

      log(`Claude TUI: sending turn (${promptText.length} chars)`);
      const turn = client.send(promptText);

      let lastTextLen = 0;
      let _lineBuf = '';

      for await (const update of turn.updates()) {
        _lastActivityMs.set(root, Date.now());
        const { snapshot } = update;

        // Stream any newly accumulated text to the output channel + capture file.
        if (snapshot.text.length > lastTextLen) {
          const newChunk = snapshot.text.slice(lastTextLen);
          lastTextLen = snapshot.text.length;
          try { fs.appendFileSync(stdoutFile, newChunk, 'utf8'); } catch { /* ignore */ }

          // Log only complete lines (terminated by \n) so partial streaming
          // updates don't produce fragmented mid-word log entries.
          _lineBuf += newChunk;
          let nl: number;
          while ((nl = _lineBuf.indexOf('\n')) !== -1) {
            const line = _lineBuf.slice(0, nl).replace(/\r$/, '');
            _lineBuf = _lineBuf.slice(nl + 1);
            if (line) { log(`  ${line}`); }
          }
        }

        // Auto-approve all tool-use / hook requests.
        for (const req of snapshot.openRequests) {
          try {
            if (req.kind === 'tool_approval' || req.kind === 'hook') {
              await client.approveRequest(req.id);
            } else if (req.kind === 'question') {
              await client.answerQuestion(req.id, {});
            }
          } catch { /* already resolved or unknown kind */ }
        }

        if (update.kind === 'completed' || update.kind === 'error') { break; }
      }

      // Flush any remaining partial line.
      if (_lineBuf.trim()) { log(`  ${_lineBuf}`); _lineBuf = ''; }

      // Capture session after turn completes.
      if (client.sessionId) { _latestSessionIds.set(root, client.sessionId); }
      log(`Claude TUI: turn complete`);
      try { fs.writeFileSync(exitFile, '0\n', 'utf8'); } catch { /* ignore */ }

    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log(`Claude TUI error: ${msg}`);
      _evictClient(root);  // kill stale process; next task gets a fresh client
      try { fs.appendFileSync(stdoutFile, `\n[Error: ${msg}]\n`, 'utf8'); } catch { /* ignore */ }
      try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
    } finally {
      _busyRoots.delete(root);
    }
  })();
}

// ---------------------------------------------------------------------------
// runClaudeTuiCompact
//
// Sends /compact to the active session to free up context window space.
// Awaitable -- resolves once the compact turn finishes.
// ---------------------------------------------------------------------------
export async function runClaudeTuiCompact(
  root: string,
  sessionId: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const client = await getOrCreateClient(root, sessionId, log);
    log(`Claude TUI compact: sending /compact`);
    const turn = client.send('/compact');
    await turn.done;
    log(`Claude TUI compact: done`);
  } catch (err) {
    log(`Claude TUI compact error: ${(err as Error)?.message ?? String(err)}`);
    _evictClient(root);
  }
}

// ---------------------------------------------------------------------------
// runClaudeTuiClear
//
// Sends /clear to the active session to wipe history and start fresh.
// Used when autocompact is thrashing (context refills immediately after compact).
// ---------------------------------------------------------------------------
export async function runClaudeTuiClear(
  root: string,
  sessionId: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const client = await getOrCreateClient(root, sessionId, log);
    log(`Claude TUI clear: sending /clear`);
    const turn = client.send('/clear');
    await turn.done;
    log(`Claude TUI clear: done`);
    _evictClient(root);
  } catch (err) {
    log(`Claude TUI clear error: ${(err as Error)?.message ?? String(err)}`);
    _evictClient(root);
  }
}

// ---------------------------------------------------------------------------
// detectTuiRateLimit
// ---------------------------------------------------------------------------
export function detectTuiRateLimit(stdoutContent: string): ReturnType<typeof RateLimitDetector.detect> {
  return RateLimitDetector.detect(stdoutContent);
}
