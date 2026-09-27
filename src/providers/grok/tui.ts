// ---------------------------------------------------------------------------
// grokProvider -- Grok tasks via the `grok` CLI. Backs BOTH provider variants:
//
//   grok-cli  (stateless):  fresh HEADLESS process each task (--prompt-file),
//                           no context accumulation across tasks.
//   grok-tui  (persistent): ONE long-lived interactive `grok` process kept alive
//                           inside a per-workspace tmux session (a real PTY), so
//                           grok's in-process context accumulates across tasks —
//                           exactly like a human-driven interactive session.
//
// -------------------------------------------------------------------------
// Why tmux for grok-tui?
// -------------------------------------------------------------------------
// grok is an interactive terminal UI. The OLD grok-tui ran it HEADLESS with
// piped, non-TTY stdio (`--prompt-file --output-format streaming-json`, stdin
// ignored). Under load it would finish producing output but never terminate the
// process (no controlling TTY to close on, an internal render/input wait, or a
// tool it retried forever). `close` never fired → the per-message exit file was
// never written → the task loop blocked until its 30 s sentinel / the 10 min
// watchdog, and the turn surfaced as a StopFailure. The wedge root-cause was the
// no-TTY non-exit.
//
// The tmux reimplementation gives grok a real PTY. One detached tmux session per
// workspace runs `grok --no-alt-screen --always-approve` interactively; each
// task PASTES its prompt into the live pane and detects turn-end by output
// quiescence (recipe below). Context lives in the one long-running grok process
// — the live session IS the resumed context, so we no longer `--resume` per task.
//
// Contract preserved for taskLoop (unchanged): stream assistant/pane text to the
// SAME per-message stdoutFile; write the exit code to the SAME per-message
// exitFile exactly ONCE, only when the turn genuinely ends. Session id is still
// minted-once and persisted under getSessionId/saveSessionId('grok-tui') so the
// office/loop see continuity and a dead session can be relaunched with --resume.
//
// If tmux is not installed, grok-tui transparently FALLS BACK to the old
// headless spawn so nothing regresses on boxes without tmux.
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import * as child_process from 'child_process';
import { randomUUID } from 'crypto';
import { ensureGrokTrustAt } from './trustStore';
import { eventTypeFor } from '../../hookEventNormalizer';
import { RateLimitDetector } from '../../rateLimit';
import { saveSessionId, getSessionId, clearSessionId } from '../../sessionState';
import { MCP_STARTUP_TIMEOUT_DEFAULT_SEC } from '../../core/mcpStartupTimeout';
import { killProcessTree } from '../../core/killProcessTree';
import { classifyGrokTurn, GROK_AUTH_MARKERS, GROK_REAUTH_MESSAGE, isGrokAuthFailure } from './authClassify';
import { scanGrokTurnEnd, scanGrokFirstToken, scanGrokTurnStart, grokLoopForwardHooks } from '../../core/grokEvents';
import { newestGrokSessionDir, grokSessionDirFor, getGrokLatestSessionId } from './sessions';
import { redactSecrets, redactDeep } from '../../core/redactSecrets';
import { GrokAcpSession } from './GrokAcpSession';
import { AcpSession } from '../acp/AcpSession';
import type { AcpHostHooks } from './GrokAcpSession';
import type { ProviderId } from '../../providers';
import { leaderModeEnabled, ensureLeader, stopLeader } from './leader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the grok binary — use env override for non-default installs. */
const GROK_BIN = process.env['GROK_BIN'] ?? (() => {
  // Prefer a grok on PATH; otherwise fall back to the default install location
  // (~/.grok/bin/grok) so the provider works without PATH changes.
  try {
    const home = os.homedir();
    const local = path.join(home, '.grok', 'bin', 'grok');
    if (fs.existsSync(local)) { return local; }
  } catch { /* ignore */ }
  return 'grok';
})();

/** tmux binary — overridable for non-standard installs. */
const TMUX_BIN = process.env['TMUX_BIN'] ?? 'tmux';

// Env-tunable knobs. `envNum` accepts any finite >= 0; 0 disables that guard.
const envNum = (key: string, def: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// ---------------------------------------------------------------------------
// Per-workspace state
// ---------------------------------------------------------------------------

/** Roots with an actively-running grok turn (headless OR tmux). */
const _busyRoots = new Set<string>();

/** Active HEADLESS child processes by root — grok-cli + tmux-unavailable fallback. */
const _activeChildren = new Map<string, child_process.ChildProcess>();

/**
 * CONSECUTIVE headless-`grok --resume` failures per root (probe hang OR an
 * error-before-first-token). This REPLACES the old permanent `_resumeBroken` set,
 * which — after a SINGLE transient resume hiccup — forced every later turn STATELESS
 * (a fresh, unknown session id each turn → no conversation continuity for the rest
 * of the run). Empirically `grok --resume <id>` is reliable and near-instant on the
 * current grok (1.0.13: first_token ~40ms on resume, correct cross-turn recall), so
 * a resume failure is treated as TRANSIENT, not terminal: the count is RESET to 0 the
 * moment a resumed turn produces its first_token, and the headless path RE-ATTEMPTS
 * `--resume <storedId>` on the very next turn. Only after RESUME_MAX_CONSEC_FAILURES
 * straight failures does one turn take a stateless "breather" (skip the probe once),
 * after which the count resets and resume is tried again — so persistence is never
 * permanently abandoned. The STORED session id is preserved across every fallback
 * (stateless relaunch uses persist:false and never overwrites it), so continuity
 * resumes as soon as the transient condition clears. Cleared when the session closes.
 */
const _resumeFailures = new Map<string, number>();
/** Straight resume failures before ONE stateless breather turn (then retry resume). */
const RESUME_MAX_CONSEC_FAILURES = Math.max(1, envNum('AUTODEV_GROK_RESUME_MAX_FAILS', 3));
const _resumeFailCount = (root: string): number => _resumeFailures.get(root) ?? 0;
const _noteResumeFailure = (root: string): void => { _resumeFailures.set(root, _resumeFailCount(root) + 1); };
const _noteResumeSuccess = (root: string): void => { _resumeFailures.delete(root); };

/** Live tmux-backed grok sessions by root (persistent grok-tui). */
interface TmuxSession {
  name: string;       // tmux session name (deterministic from root)
  rawLog: string;     // pipe-pane capture file (append-only, ANSI-laden)
  sessionId: string;  // grok session UUID (persisted to session-state.json)
  readOffset: number; // bytes of rawLog already streamed to a stdoutFile
}
const _tmuxSessions = new Map<string, TmuxSession>();

/**
 * Live PERSISTENT `grok agent stdio` ACP sessions by root (the persistent-process
 * model). ONE long-lived grok per workspace serves many turns without exiting;
 * resume happens only at (re)start via session/load. See GrokAcpSession.
 */
const _acpSessions = new Map<string, GrokAcpSession>();

/** Roots where the leader backend FAILED to come up this run (e.g. the AF_UNIX
 *  socket never appeared — a known risk on Windows, where grok 1.0.41 has no TCP
 *  alternative to `--leader-socket`). Once a root is in here we STOP re-spawning a
 *  leader every turn (no retry-churn) and quietly use the non-leader ACP path for
 *  the rest of the run. Cleared by `recoverLeaderPoison` so a deliberate reap can
 *  try a fresh leader again. */
const _leaderUnavailable = new Set<string>();

/** Cached probe: does this grok build expose `agent stdio` (the ACP transport)? */
let _grokAgentStdioSupported: boolean | null = null;
export function grokAgentStdioSupported(): boolean {
  if (_grokAgentStdioSupported !== null) { return _grokAgentStdioSupported; }
  try {
    const out = child_process.execFileSync(GROK_BIN, ['agent', '--help'], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] });
    _grokAgentStdioSupported = /\bstdio\b/.test(out);
  } catch { _grokAgentStdioSupported = false; }
  return _grokAgentStdioSupported;
}

/**
 * Whether the persistent ACP path is active. Gated on grok supporting `agent
 * stdio` AND the AUTODEV_GROK_PERSISTENT env override (default ON when supported;
 * set to 'false'/'0'/'off' to force the legacy one-shot headless path).
 */
export function grokAcpEnabled(): boolean {
  const raw = String(process.env['AUTODEV_GROK_PERSISTENT'] ?? '').toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') { return false; }
  return grokAgentStdioSupported();
}

// Per-root set of grok tool_call ids already emitted as PreToolUse, so a re-scan of
// the transcript can't emit the SAME tool call twice → duplicate rows in the office
// hook feed (observed ~2.4× per call). PostToolUse is already dedup'd by pending.delete;
// PreToolUse had no guard. tool_call ids are unique per call, so this is exact. Bounded
// so an overnight run can't grow it unboundedly; cleared when the session is closed.
const _emittedToolIds = new Map<string, Set<string>>();
const EMITTED_TOOL_IDS_CAP = 8000;

// Reap grok on process shutdown. grok runs in a DETACHED tmux session that outlives
// the loop, so killing the loop (app Stop, `autodev stop`, SIGTERM) would otherwise
// ORPHAN grok — it keeps running/burning tokens, its stale office presence makes the
// agent look stuck ("Stopping…" forever), and orphans accumulate across restarts.
// closeAllGrokTuiSessions() (defined below, hoisted) reaps every session this process
// launched; it was previously only wired to SDK/extension shutdown, not the standalone
// `autodev start` loop. A signal handler suppresses Node's default terminate, so we
// re-exit after the sync cleanup; 'exit' is a backstop for other exit paths. No other
// SIGTERM/SIGINT handler exists in the CLI, so taking the signal here is safe.
let _grokShuttingDown = false;
function _grokReapOnSignal(sig: NodeJS.Signals): void {
  if (_grokShuttingDown) { return; }
  _grokShuttingDown = true;
  try { closeAllGrokTuiSessions(); } catch { /* best effort */ }
  process.exit(sig === 'SIGINT' ? 130 : 143);
}
try {
  process.on('SIGTERM', () => _grokReapOnSignal('SIGTERM'));
  process.on('SIGINT', () => _grokReapOnSignal('SIGINT'));
  process.on('exit', () => { try { closeAllGrokTuiSessions(); } catch { /* best effort */ } });
} catch { /* handlers restricted in this env */ }

/** Epoch-ms of the last streamed pane growth per root (activity heartbeat). */
const _lastActivityMs = new Map<string, number>();

/** True while a grok turn is running for the given workspace root. */
export function isGrokTuiBusy(root: string): boolean {
  return _busyRoots.has(root);
}

/** Epoch-ms of the most recent streamed pane activity, or 0 if none. */
export function getGrokTuiLastActivity(root: string): number {
  return _lastActivityMs.get(root) ?? 0;
}

/** Force-clear the busy flag for a root whose turn appears hung. */
export function forceIdleGrokTui(root: string): void {
  _busyRoots.delete(root);
}

/**
 * Append a REAL grok activity event to `.autodev/hooks-events.jsonl` in the
 * native Claude-Code hook schema (pixel-office reads `hook_event_name`).
 */
function _emitGrokHook(root: string, hookEventName: string, extra: Record<string, unknown> = {}): void {
  try {
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const ev = { hook_event_name: hookEventName, event_type: eventTypeFor(hookEventName), provider: 'grok-tui', cwd: root, timestamp: new Date().toISOString(), ...extra };
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* non-critical */ }
}

/**
 * Surface a grok NOT-SIGNED-IN / auth failure from the HEADLESS or ACP error
 * surface (no tmux pane) LOUDLY and non-retryably. Emits the first-class
 * `reauth_required` hook (→ cliExit maps it to a NON-retryable hard-failure and
 * the desktop app / office read it from hooks-events.jsonl as the 🔑 needs-auth
 * state) AND writes the GROK_REAUTH_MESSAGE sentinel into the stdout capture (→
 * the loop's AuthDetector raises an AuthError and takes its dedicated reauth
 * PAUSE with the accurate active provider). The caller still owns writing the
 * exit file. `providerLabel` tags the hook so grok-cli vs grok-tui is correct;
 * `_emitGrokHook`'s default provider is overridden by the spread.
 */
function _emitGrokReauthHook(
  root: string,
  stdoutFile: string,
  log: (msg: string) => void,
  where: string,
  providerLabel: string,
  diag?: string,
): void {
  const detail = diag ? ` — grok said: "${diag.slice(0, 160)}"` : '';
  log(`Grok: reauthentication required — ${where}${detail}`);
  _emitGrokHook(root, 'reauth_required', {
    provider: providerLabel,
    message: `${GROK_REAUTH_MESSAGE}${detail}`,
    title: 'Authentication required',
    tool_name: '',
  });
  try { fs.appendFileSync(stdoutFile, `\n[Grok: ${GROK_REAUTH_MESSAGE}]\n`, 'utf8'); } catch { /* ignore */ }
}

/**
 * Read NEW bytes of a jsonl file past `off`, returning only COMPLETE lines and
 * the advanced offset (a half-written trailing record is re-read next tick). Never
 * throws — a missing/short file yields no lines and the offset unchanged. Mirrors
 * the operate bridge's grok tailer so both paths tail grok's logs identically.
 */
function drainNewJsonlLines(file: string, off: number): { lines: string[]; offset: number } {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { lines: [], offset: off }; }
  if (size <= off) { return { lines: [], offset: off }; }
  let raw = '';
  try {
    const len = size - off;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, off); } finally { fs.closeSync(fd); }
    raw = buf.toString('utf8');
  } catch { return { lines: [], offset: off }; }
  const lastNl = raw.lastIndexOf('\n');
  if (lastNl < 0) { return { lines: [], offset: off }; } // no complete line yet
  const complete = raw.slice(0, lastNl);
  const newOff = off + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the \n
  return { lines: complete.split('\n'), offset: newOff };
}

// ---------------------------------------------------------------------------
// tmux helpers — all synchronous, best-effort (swallow + report).
// ---------------------------------------------------------------------------

let _tmuxAvailable: boolean | null = null;
/** True if tmux is installed and runnable. Cached after first probe. */
export function tmuxAvailable(): boolean {
  if (_tmuxAvailable !== null) { return _tmuxAvailable; }
  try {
    child_process.execFileSync(TMUX_BIN, ['-V'], { stdio: 'ignore', timeout: 5_000 });
    _tmuxAvailable = true;
  } catch { _tmuxAvailable = false; }
  return _tmuxAvailable;
}

/** Run a tmux subcommand; returns stdout string, or null on any failure. */
function tmux(args: string[], input?: string): string | null {
  try {
    const out = child_process.execFileSync(TMUX_BIN, args, {
      encoding: 'utf8', timeout: 15_000, input, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out ?? '';
  } catch { return null; }
}

/** Deterministic, tmux-safe session name from the absolute workspace path. */
function sessionName(root: string): string {
  const h = crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
  return `grok-${h}`;
}

/** True if the tmux session exists (a dead grok collapses the session). */
function hasSession(name: string): boolean {
  try {
    child_process.execFileSync(TMUX_BIN, ['has-session', '-t', name], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch { return false; }
}

/** Kill a tmux session (best-effort). */
function killSession(name: string): void {
  tmux(['kill-session', '-t', name]);
}

/** Escape-stripped visible grid + scrollback of a pane (for detection). */
function capturePane(name: string, scrollback = 200): string {
  const out = tmux(['capture-pane', '-p', '-t', name, '-S', `-${scrollback}`]);
  return out === null ? '' : stripAnsi(out);
}

/** Shell-quote a single argument for a `send-keys "exec …"` command string. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip ANSI/OSC/DCS escapes and carriage returns from raw pane bytes.
 * `pipe-pane` captures the full TUI byte stream (SGR colour, mouse tracking,
 * bracketed-paste markers, OSC titles, `\r`), which must be removed before the
 * text is written to stdoutFile or scanned for banners.
 */
function stripAnsi(s: string): string {
  return s
    // CSI sequences: ESC [ ... final-byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences: ESC ] ... (BEL | ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS/PM/APC: ESC (P|X|^|_) ... ST
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    // Any other single-char escape
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

// ---------------------------------------------------------------------------
// Turn-end / auth detectors (calibrate against a live authed grok — see risks).
// ---------------------------------------------------------------------------

/**
 * Markers that mean grok hit the OAuth/expired-token gate or a manual-login /
 * failed-refresh auth failure instead of doing work. The loop must treat this
 * as reauth, NOT a hung turn. Sourced from ./authClassify (shared with the unit
 * tests) — broadened beyond the old login-gate-only set to also catch grok's
 * `Failed(ManualLogin)` / failed silent-refresh signals that previously slipped
 * through as a plain turn-failure (or a false idle).
 */
const REAUTH_MARKERS = GROK_AUTH_MARKERS;

/**
 * True when grok's credential file (`~/.grok/auth.json`) exists and is
 * non-empty. The PROVEN root cause of the failing Windows agent is this file
 * intermittently going MISSING → grok's silent token refresh fails
 * (`Failed(ManualLogin)`) → the turn dies. A missing/empty auth.json is a
 * deterministic auth-failure signal we can check directly, independent of what
 * the pane happens to render. `GROK_AUTH_JSON` overrides the path for non-default
 * installs. Absence is only USED to disambiguate an actual turn-failure/death —
 * never to flag a healthy, still-producing turn.
 */
function grokAuthPresent(): boolean {
  try {
    const p = process.env['GROK_AUTH_JSON'] || path.join(os.homedir(), '.grok', 'auth.json');
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

/**
 * "grok finished this turn" affordance — CALIBRATED against grok 4.5 build 0.2.93:
 * a completed turn prints "Worked for 4.1s." (a summary line) and the footer drops
 * the cancel affordance. Used as a fast, positive turn-end confirmation.
 */
const DONE_MARKER = /worked for\s+[\d.]+\s*s\b/i;

/**
 * "grok is actively working" affordance. grok renders a live spinner + an
 * "esc to interrupt"-style footer while a turn runs. If present we never
 * declare idle. This is a SOFT guard: the primary idle signal is output
 * quiescence + a byte-identical pane snapshot across polls (a running spinner
 * animates, so the snapshot is never stable while grok works), which fires
 * cleanly even if this pattern never matches on a given grok build.
 */
// CALIBRATED against real grok 4.5 (build 0.2.93): while a turn runs the footer
// shows "Ctrl+c:cancel" and a "⠧ Waiting for response… 1.5s … [stop]" status line;
// when idle the footer is only "Shift+Tab:mode │ Ctrl+x:shortcuts" (no Ctrl+c).
// So the presence of Ctrl+c / "waiting for response" / "[stop]" / a braille spinner
// = working. This is the primary running signal (backed by output-quiescence).
const RUNNING_INDICATOR = /ctrl\+c\s*[: ]|waiting for response|\[stop\]|esc to (?:interrupt|cancel)|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/i;

// ---------------------------------------------------------------------------
// grok-tui: persistent interactive session driven through tmux.
// ---------------------------------------------------------------------------

/** Launch a fresh grok process in a new detached tmux session for this root. */
/** Block the calling thread for `ms` — launchSession is synchronous, so the
 *  cross-process launch serialization below needs a synchronous wait. */
function sleepSyncMs(ms: number): void {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

// ── Cross-process grok-tui launch serialization ─────────────────────────────
// Every office agent runs in its OWN `autodev start` process, so an in-process
// mutex can't help: when many agents fire a turn at the same instant they all
// hit `tmux new-session` (and the shared ~/.grok config) simultaneously, the
// tmux server races on startup, and grok dies during startup ("session died
// during startup"). A lockfile + a minimum spacing between launches turns that
// stampede into an orderly ~1-launch-per-second queue. Tunable/disable via
// GROK_TMUX_LAUNCH_SPACING_MS (0 disables the spacing; the lock still serializes).
const TMUX_LAUNCH_LOCK  = path.join(os.homedir(), '.grok', '.autodev-tmux-launch.lock');
const TMUX_LAUNCH_STAMP = path.join(os.homedir(), '.grok', '.autodev-tmux-launch.stamp');
// 10s default: 1s only spaced the tmux new-session call, but grok's ~9s startup
// (where it initializes its session + writes the shared session_search.sqlite
// index) still overlapped across agents and raced. Holding the slot ~10s lets
// each grok fully initialize its session before the next one launches.
const TMUX_LAUNCH_SPACING_MS = envNum('GROK_TMUX_LAUNCH_SPACING_MS', 10000);
const TMUX_LOCK_STALE_MS = 15000;

/** Acquire the shared launch slot (atomic-create lockfile, steal if stale), then
 *  wait out the minimum spacing since the previous launch. Best-effort: never
 *  blocks a turn forever. */
function acquireTmuxLaunchSlot(log: (m: string) => void): void {
  try { fs.mkdirSync(path.dirname(TMUX_LAUNCH_LOCK), { recursive: true }); } catch { /* ignore */ }
  const deadline = Date.now() + 45000;
  for (;;) {
    try { fs.closeSync(fs.openSync(TMUX_LAUNCH_LOCK, 'wx')); break; } // atomic exclusive create = acquired
    catch {
      try {
        const st = fs.statSync(TMUX_LAUNCH_LOCK);
        if (Date.now() - st.mtimeMs > TMUX_LOCK_STALE_MS) { try { fs.unlinkSync(TMUX_LAUNCH_LOCK); } catch { /* race */ } continue; }
      } catch { continue; } // lock vanished mid-check → retry create
      if (Date.now() > deadline) { log('Grok TUI: tmux-launch lock wait timed out — launching anyway'); return; }
      sleepSyncMs(120);
    }
  }
  try {
    const last = Number(fs.readFileSync(TMUX_LAUNCH_STAMP, 'utf8')) || 0;
    sleepSyncMs(TMUX_LAUNCH_SPACING_MS - (Date.now() - last));
  } catch { /* no prior stamp */ }
}

/** Stamp the launch time (for the next launcher's spacing) and release the lock. */
function releaseTmuxLaunchSlot(): void {
  try { fs.writeFileSync(TMUX_LAUNCH_STAMP, String(Date.now())); } catch { /* ignore */ }
  try { fs.unlinkSync(TMUX_LAUNCH_LOCK); } catch { /* ignore */ }
}

// grok keeps a SHARED session index at ~/.grok/sessions/session_search.sqlite.
// In the default rollback journal mode a writer takes an exclusive lock, so when
// many agents initialize a session at once they block/fail on it and grok dies
// during startup. Enabling WAL (persistent — stored in the db header, so once is
// enough) lets concurrent readers/writers proceed without that exclusive-lock
// stampede. Best-effort via node:sqlite (Node ≥22), falling back to the sqlite3
// CLI; if neither is available the launch spacing still serializes access.
let _grokWalEnsured = false;
function ensureGrokSessionDbWal(log: (m: string) => void): void {
  if (_grokWalEnsured) return;
  const db = path.join(os.homedir(), '.grok', 'sessions', 'session_search.sqlite');
  if (!fs.existsSync(db)) return; // grok hasn't created it yet — retry on a later launch
  const PRAGMAS = 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db);
    d.exec(PRAGMAS);
    d.close();
    _grokWalEnsured = true;
    log('Grok TUI: enabled WAL on session_search.sqlite');
    return;
  } catch { /* node:sqlite unavailable → try the CLI */ }
  try {
    child_process.execSync(`sqlite3 ${shq(db)} ${shq(PRAGMAS)}`, { stdio: 'ignore', timeout: 5000 });
    _grokWalEnsured = true;
    log('Grok TUI: enabled WAL on session_search.sqlite (sqlite3)');
  } catch { /* best effort — spacing still serializes */ }
}

function launchSession(root: string, sessionId: string, resume: boolean, model: string | undefined, log: (m: string) => void): TmuxSession {
  const name = sessionName(root);
  // A stale/dead session for this name must be cleared first.
  if (hasSession(name)) { killSession(name); }

  // Per-agent pane log (distinct file per root → no cross-agent race).
  const dir = path.join(root, '.autodev', 'grok-tui');
  try { if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); } } catch { /* ignore */ }
  const rawLog = path.join(dir, 'pane.raw');
  // Start each launch with a fresh raw log so readOffset math is simple.
  try { fs.writeFileSync(rawLog, '', 'utf8'); } catch { /* ignore */ }

  // Build the interactive grok command. `exec` replaces the shell so a dead grok
  // collapses the pane/session → cheap liveness signal via has-session. (Pure
  // string work — no shared state — so it stays outside the launch lock.)
  // Launch grok via `env -u TMUX -u TMUX_PANE TERM=xterm-256color`: although grok
  // physically runs inside our tmux pane (so we can capture it), inheriting the
  // pane's TMUX/TMUX_PANE + TERM=screen makes grok take a NESTED-tmux terminal
  // path — under load its /dev/tty window-size handshake times out after ~11s and
  // grok exits CLEANLY (exit_group(0)), which we misread as "session died during
  // startup". Hiding the nesting (proper TERM, no TMUX) makes grok use the normal
  // terminal path and it stays alive. (strace-confirmed 2026-08-02.)
  // The pane inherits the tmux SERVER's env, not our process — so explicitly
  // stamp the MCP startup timeout onto the launch `env` here. Honor a value the
  // caller already set on process.env (GrokProvider.dispatch → applyMcpStartupEnv,
  // or a user override); otherwise fall back to the default. Grok ignores
  // config.toml's startup_timeout_sec, so this env var is the real knob.
  const grokMcpStartupSecs =
    process.env['GROK_MCP_STARTUP_TIMEOUT_SECS'] || String(MCP_STARTUP_TIMEOUT_DEFAULT_SEC);
  const parts = [
    'exec', 'env', '-u', 'TMUX', '-u', 'TMUX_PANE', 'TERM=xterm-256color',
    `GROK_MCP_STARTUP_TIMEOUT_SECS=${grokMcpStartupSecs}`,
    shq(GROK_BIN),
    '--no-alt-screen', '--always-approve',
    '--cwd', shq(root),
  ];
  if (model) { parts.push('-m', shq(model)); }
  if (resume) {
    // Restore the accumulated conversation on relaunch.
    parts.push('--resume', shq(sessionId));
  } else {
    // Name a brand-new conversation with our UUID so it is addressable later.
    parts.push('-s', shq(sessionId));
  }

  // Serialize the race-prone work — the shared ~/.grok config write and the tmux
  // server interactions — across the per-agent loop processes, spaced ~1s apart,
  // so a burst of simultaneous turns can't race the tmux server startup and kill
  // grok ("session died during startup").
  acquireTmuxLaunchSlot(log);
  try {
    // Put grok's shared session index into WAL so concurrent session inits don't
    // block on an exclusive rollback-journal lock (a cause of startup crashes).
    ensureGrokSessionDbWal(log);
    // Kill the one-time project-directory picker before it can block the turn.
    ensureGrokPickerDisabled(log);
    // Trust the workspace dir so grok skips its "Do you trust this directory?"
    // gate (a first-run-only prompt that otherwise kills the turn — see fn doc).
    ensureGrokDirTrusted(root, log);
    // Pre-create grok's per-session dir + an empty transcript for a NEW session so
    // grok doesn't have to mkdir it (and register it in the shared
    // ~/.grok/sessions/session_search.sqlite index) during startup — that
    // filesystem/sqlite contention across a burst of concurrent launches is a
    // suspected cause of the immediate "session died during startup". A resumed
    // session already has its dir, so skip it there.
    if (!resume) {
      try {
        const sPath = chatHistoryPath(root, sessionId);
        fs.mkdirSync(path.dirname(sPath), { recursive: true });
        if (!fs.existsSync(sPath)) { fs.writeFileSync(sPath, '', 'utf8'); }
      } catch { /* best effort */ }
    }
    // Kill any stale session with this name first. launchSession only runs when
    // there's no live in-process session, so an existing tmux session by this name
    // is an ORPHAN from a previous loop instance (the tmux session outlives a
    // killed loop). Without this, `new-session` fails "duplicate session" on
    // restart, and orphans accumulate. The shutdown handler (closeAllGrokTuiSessions)
    // normally reaps them, but a SIGKILL'd loop can't run it — so reap here too.
    try { killSession(name); } catch { /* none to kill */ }
    // Fixed geometry so wrapping/relayout never shifts detection rows; manual
    // window-size so a human attaching can't reflow the pane mid-turn.
    tmux(['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', root]);
    tmux(['set-option', '-t', name, 'window-size', 'manual']);
    // pipe-pane BEFORE launching grok — it only captures bytes emitted after it
    // attaches (confirmed). Append mode.
    tmux(['pipe-pane', '-o', '-t', name, `cat >> ${shq(rawLog)}`]);
    tmux(['send-keys', '-t', name, parts.join(' '), 'Enter']);
  } finally {
    releaseTmuxLaunchSlot();
  }

  const sess: TmuxSession = { name, rawLog, sessionId, readOffset: 0 };
  _tmuxSessions.set(root, sess);
  log(`Grok TUI: launched tmux session ${name} (${resume ? 'resume' : 'new'} ${sessionId.slice(0, 8)}…, model=${model || 'account default'})`);
  return sess;
}

/**
 * Ensure a live tmux grok session exists for this root. Returns the session and
 * whether it was just launched (caller applies a startup grace before pasting).
 */
function ensureSession(root: string, resolvedSessionId: string | undefined, model: string | undefined, log: (m: string) => void): { sess: TmuxSession; justLaunched: boolean } {
  const name = sessionName(root);
  const cached = _tmuxSessions.get(root);
  if (cached && cached.name === name && hasSession(name)) {
    return { sess: cached, justLaunched: false }; // reuse — context is live in-process
  }
  // No live session. If we have a stored session id, relaunch with --resume so
  // grok restores the accumulated history; otherwise mint + persist a new UUID.
  let sid = resolvedSessionId || getSessionId(root, 'grok-tui');
  let resume = false;
  if (sid) {
    resume = true; // a stored id means grok already has a persisted session
  } else {
    sid = randomUUID();
    try { saveSessionId(root, 'grok-tui', sid); } catch { /* best effort */ }
  }
  const sess = launchSession(root, sid, resume, model, log);
  return { sess, justLaunched: true };
}

/** Read new bytes of rawLog past `offset`; returns decoded text + new offset. */
function readFrom(file: string, offset: number): { text: string; offset: number } {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) { return { text: '', offset }; }
    const len = size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    return { text: buf.toString('utf8'), offset: size };
  } catch { return { text: '', offset }; }
}

/**
 * grok persists a CLEAN structured transcript per workspace session at
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
 * one JSON object per line: {type:'system'|'user'|'reasoning'|'assistant'|
 * 'tool_result', content, tool_calls?}. The assistant `content` is the real
 * message text (markdown), with none of the TUI chrome — spinners, "Waiting for
 * response…", token counters, "Ctrl+x:shortcuts", load-bar glyphs — that scraping
 * the live tmux pane drags in. We read the agent's OUTPUT from here; the pane is
 * used only for turn-end/reauth detection.
 */
function chatHistoryPath(root: string, sessionId: string): string {
  return path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(root), sessionId, 'chat_history.jsonl');
}

/**
 * A NEW grok session shows a one-time "Run Grok Build in a project directory?"
 * picker before the first turn's work, which blocks headless automation. grok
 * exposes a persistent opt-out — `hints = { project_picker_disabled = true }` in
 * ~/.grok/config.toml (what its "Don't ask me again" option writes). Ensure it is
 * present before launching so the session goes straight to the prompt. Idempotent;
 * the poll-loop picker backstop covers any grok build that ignores this.
 */
function ensureGrokPickerDisabled(log: (m: string) => void): void {
  try {
    const cfg = path.join(os.homedir(), '.grok', 'config.toml');
    let text = '';
    try { text = fs.readFileSync(cfg, 'utf8'); } catch { /* no config yet */ }
    if (/project_picker_disabled\s*=\s*true/.test(text)) { return; }
    if (/^hints\s*=\s*\{/m.test(text)) {
      // Inject the key into the existing inline `hints` table.
      text = text.replace(/^hints\s*=\s*\{/m, 'hints = { project_picker_disabled = true,');
    } else {
      text = 'hints = { project_picker_disabled = true }\n' + text;
    }
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, text, 'utf8');
    log('Grok TUI: disabled grok project-directory picker in config.toml');
  } catch { /* best effort — the poll-loop dismissal is the backstop */ }
}

/**
 * Pre-trust the workspace directory in ~/.grok/trusted_folders.toml so grok skips
 * its "Do you trust the contents of this directory?" startup gate. That gate is
 * NOT the project picker (ensureGrokPickerDisabled) and is not covered by the
 * startup picker loop — if it shows, the loop mistakes the blank body for the
 * ready prompt, pastes the turn into the trust dialog, grok reads it as "not y"
 * and QUITS (observed as "session-exit" right after "sending turn"). Untrusted
 * dirs are the ones an agent has never run in before, so this is the durable fix
 * for the "some agents crash on first launch" class. Idempotent: skip if already
 * present.
 */
function ensureGrokDirTrusted(root: string, log: (m: string) => void): void {
  // The folder is keyed as a DOUBLE-QUOTED TOML header `[folders."<path>"]`, so
  // the path MUST be TOML-escaped (backslashes doubled) or a Windows path breaks
  // grok's TOML parser. ensureGrokTrustAt owns that escape and also repairs a
  // store the old raw-path bug corrupted. Best-effort — never throws.
  const tf = path.join(os.homedir(), '.grok', 'trusted_folders.toml');
  const r = ensureGrokTrustAt(tf, root);
  if (r === 'appended') {
    log(`Grok TUI: trusted workspace dir in trusted_folders.toml (skips grok's trust gate)`);
  } else if (r === 'repaired') {
    log(`Grok TUI: repaired a corrupt trusted_folders.toml (unescaped Windows paths) and trusted workspace dir`);
  }
}

/** Cap a string field to `max` chars, appending an ellipsis when truncated. */
function _truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Parse a grok tool_call `arguments` JSON string into a plain OBJECT suitable
 * for the office `tool_input` field, which the pixel-office normalizer requires
 * to be an array/object (a raw string is dropped). Long string values are
 * truncated so a huge write/patch payload can't bloat the hook line. Non-JSON
 * arguments fall back to `{ _raw: <truncated> }` so tool_input is still an object.
 */
function _parseToolInput(argsStr: string | undefined): Record<string, unknown> {
  const raw = (argsStr ?? '').trim();
  if (!raw) { return {}; }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'string') { obj[k] = _truncStr(obj[k] as string, 2000); }
      }
      return obj;
    }
    // JSON that isn't an object (number/array/string) — wrap it.
    return { value: parsed };
  } catch {
    return { _raw: _truncStr(raw, 2000) };
  }
}

/** Assistant tool_call record entry as persisted in grok's chat_history.jsonl. */
interface GrokToolCall { id?: string; name?: string; arguments?: string }

/**
 * Scan NEW chat_history.jsonl records past `offset` and emit ONE rich hook event
 * per grok tool call: `PreToolUse` when the assistant record's `tool_calls[]`
 * entry first appears (carrying tool_name + parsed tool_input), then `PostToolUse`
 * when its matching `tool_result` (by tool_call_id) lands (carrying tool_name +
 * tool_input + tool_output.text). `pending` (keyed by tool_call id) survives
 * across polls so a Pre/Post pair split over two reads is matched. Advances the
 * offset only past COMPLETE lines so a half-written trailing record is re-read.
 *
 * grok's OWN native tools (Read/Edit/Bash/Glob/…) are what surface here. Office
 * MCP tools (`mcp__…`) are skipped: the office already records those server-side
 * (OfficeMcpController → provider 'mcp-operator'), so emitting them again would
 * double-render the same call.
 */
function scanGrokToolEvents(
  root: string,
  file: string,
  offset: number,
  pending: Map<string, { name: string; input: Record<string, unknown> }>,
): number {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return offset; }
  if (size <= offset) { return offset; }
  let raw = '';
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    raw = buf.toString('utf8');
  } catch { return offset; }

  const lastNl = raw.lastIndexOf('\n');
  if (lastNl < 0) { return offset; } // no complete line yet
  const complete = raw.slice(0, lastNl);
  const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the \n

  for (const line of complete.split('\n')) {
    const s = line.trim();
    if (!s) { continue; }
    let o: { type?: string; role?: string; tool_calls?: GrokToolCall[]; tool_call_id?: string; content?: unknown };
    try { o = JSON.parse(s); } catch { continue; }
    const kind = o.type || o.role;

    if (kind === 'assistant' && Array.isArray(o.tool_calls)) {
      const emitted = _emittedToolIds.get(root) ?? (() => { const s = new Set<string>(); _emittedToolIds.set(root, s); return s; })();
      for (const tc of o.tool_calls) {
        const name = (tc?.name || '').trim();
        if (!name) { continue; }
        if (name.startsWith('mcp__')) { continue; } // office logs MCP tools server-side
        // Dedup: a re-scan of the transcript would otherwise re-emit this tool call's
        // PreToolUse → duplicate rows. tool_call ids are unique per call, so an id we
        // already emitted is a re-scan, not a real second call — skip it.
        const id = tc?.id;
        if (id && emitted.has(id)) { continue; }
        const input = _parseToolInput(tc?.arguments);
        // tool_use_id lets the office pair this PreToolUse with its PostToolUse
        // into ONE step card (useToolPairing keys on rawPayload.tool_use_id).
        // Without it, Pre and Post render as two separate cards = duplicates.
        _emitGrokHook(root, 'PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id });
        if (id) {
          pending.set(id, { name, input });
          emitted.add(id);
          if (emitted.size > EMITTED_TOOL_IDS_CAP) { emitted.clear(); } // bound memory; old ids won't re-scan
        }
      }
      continue;
    }

    if (kind === 'tool_result') {
      const id = o.tool_call_id;
      if (!id) { continue; }
      const p = pending.get(id);
      if (!p) { continue; } // no matching Pre (e.g. resumed history / skipped mcp tool) — don't emit an empty event
      pending.delete(id);
      const outText = typeof o.content === 'string' ? o.content : (o.content == null ? '' : JSON.stringify(o.content));
      _emitGrokHook(root, 'PostToolUse', {
        tool_name: p.name,
        tool_input: p.input,
        tool_output: { text: _truncStr(outText, 2000) },
        tool_use_id: id, // pair with the PreToolUse above (see note there)
      });
    }
  }
  return newOffset;
}

/**
 * Read new chat_history.jsonl records past `offset` and render only the
 * user-facing parts: assistant prose + compact tool-call markers. Skips
 * reasoning/user/system/tool_result. Advances the offset only past COMPLETE
 * lines so a half-written trailing record is re-read next poll.
 */
function drainChatHistory(file: string, offset: number): { text: string; offset: number } {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { text: '', offset }; }
  if (size <= offset) { return { text: '', offset }; }
  let raw = '';
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    raw = buf.toString('utf8');
  } catch { return { text: '', offset }; }

  const lastNl = raw.lastIndexOf('\n');
  if (lastNl < 0) { return { text: '', offset }; } // no complete line yet
  const complete = raw.slice(0, lastNl);
  const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the \n

  let out = '';
  for (const line of complete.split('\n')) {
    const s = line.trim();
    if (!s) { continue; }
    let o: { type?: string; role?: string; content?: string; tool_calls?: Array<{ name?: string; arguments?: string }> };
    try { o = JSON.parse(s); } catch { continue; }
    if ((o.type || o.role) !== 'assistant') { continue; }
    const c = (o.content || '').trim();
    if (c) { out += c + '\n'; }
    // NOTE: tool calls are NOT appended as "» tool" text markers here — they are
    // emitted as proper PreToolUse/PostToolUse hook events by scanGrokToolEvents,
    // which the office renders as (richer, paired) step cards. Emitting them here
    // too made every grok tool call appear TWICE (a card AND a text line).
  }
  return { text: out, offset: newOffset };
}

/** Type a prompt into the live pane and submit it. CALIBRATED against real grok:
 *  a tmux bracketed paste (paste-buffer) is misread by grok's TUI as a
 *  worktree/directory PICKER, not chat input — only literal keystrokes land in
 *  the input box. grok also has no reliable "newline without submit" key over
 *  send-keys (Enter submits), so flatten the prompt to one logical line. */
function pastePrompt(sess: TmuxSession, promptFilePath: string): void {
  // A full agent prompt is 10KB+ (system prompt + task + context). Typing that
  // via send-keys -l is UNRELIABLE (tmux drops/garbles keys at that size —
  // observed live), and a bracketed paste is misread by grok's TUI as a directory
  // picker. So DON'T type the prompt: hand grok a SHORT literal instruction to
  // READ the prompt file, and its file tool ingests the whole thing losslessly.
  const instr = `Read the file ${promptFilePath} in full right now — it is your current task with all its context and instructions. Do exactly what it says: do the real work, then mark the task done in TODO.md. Do not ask questions; do not skip the file.`;
  tmux(['send-keys', '-t', sess.name, '-l', instr]);
  tmux(['send-keys', '-t', sess.name, 'Enter']);
}

// ---------------------------------------------------------------------------
// runGrokTmuxTurn — one turn against the persistent tmux session.
// Fire-and-forget: streams pane text to stdoutFile, writes exitFile at turn end.
// ---------------------------------------------------------------------------
function runGrokTmuxTurn(
  root: string,
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model: string | undefined,
  showOutput?: () => void,
): void {
  showOutput?.();
  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile, '', 'utf8'); } catch { /* ignore */ }

  _busyRoots.add(root);

  const POLL_MS       = envNum('AUTODEV_GROK_TUI_POLL_MS', 700);
  const DEBOUNCE_MS   = envNum('AUTODEV_GROK_TUI_DEBOUNCE_MS', 5_000);
  // Quiescence-only fallback (no "Worked for" marker seen) needs a much longer
  // quiet window so grok's early "Starting session…"/"Reading file…" pauses aren't
  // misread as turn-end (observed a false ~4s finish). The "Worked for" marker is
  // the fast, positive done-signal for the normal case.
  const QUIET_FALLBACK_MS = envNum('AUTODEV_GROK_TUI_QUIET_FALLBACK_MS', 45_000);
  // 18s default (was 8s): only paid on a fresh launch, never on a reused live
  // session. Under a launch storm (many agents starting at once → dozens of MCP
  // servers spinning up together) grok's startup can exceed 8s; the picker loop
  // then sees a blank splash, assumes the ready prompt, and pastes the turn into a
  // not-yet-ready grok, which dies ("session-exit" right after "sending turn").
  // A longer grace lets grok reach its input prompt before we type. Override with
  // AUTODEV_GROK_TUI_STARTUP_MS for faster single-agent launches. Default 30s: 18s
  // was still too tight under a many-agents-at-once spawn (the "turn failed (provider
  // stopped or timed out)" then recover-on-retry pattern), so give grok more headroom.
  const STARTUP_MS    = envNum('AUTODEV_GROK_TUI_STARTUP_MS', 30_000);
  const NOOUTPUT_MS   = envNum('AUTODEV_GROK_TUI_NOOUTPUT_MS', 25_000);
  const MAX_RUN_MS    = envNum('AUTODEV_GROK_MAX_RUN_MS', 20 * 60_000);
  const STABLE_POLLS  = Math.max(2, envNum('AUTODEV_GROK_TUI_STABLE_POLLS', 4));

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // Line-buffer for clean console logging (grok streams mid-word).
  let lineBuf = '';
  const emitLines = (text: string): void => {
    lineBuf += text;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).replace(/\s+$/, '');
      lineBuf = lineBuf.slice(nl + 1);
      if (line.trim()) { log(`  ${line}`); }
    }
  };
  const flushLine = (): void => {
    const line = lineBuf.replace(/\s+$/, '');
    lineBuf = '';
    if (line.trim()) { log(`  ${line}`); }
  };

  // Coalesced office activity feed (grok exposes no per-tool events here).
  let activityBuf = '';
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  const flushActivity = (): void => {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    const t = activityBuf.trim(); activityBuf = '';
    if (!t) { return; }
    const preview = t.length > 280 ? t.slice(0, 277) + '…' : t;
    _emitGrokHook(root, 'Notification', { message: preview, title: 'grok', tool_name: 'grok' });
  };
  const scheduleActivity = (): void => {
    if (activityBuf.length >= 400) { flushActivity(); return; }
    if (!activityTimer) { activityTimer = setTimeout(flushActivity, 1200); }
  };

  const finish = (code: number, reason: string): void => {
    flushLine();
    flushActivity();
    _busyRoots.delete(root);
    log(`Grok TUI: turn ${code === 0 ? 'complete' : `ended (code=${code}, ${reason})`}`);
    _emitGrokHook(root, code === 0 ? 'Stop' : 'StopFailure', { exit_code: code });
    _emitGrokHook(root, 'SessionEnd', { reason: code === 0 ? 'completed' : reason });
    try { fs.writeFileSync(exitFile, `${code}\n`, 'utf8'); } catch { /* ignore */ }
  };

  // Surface a grok AUTH failure (needs re-login) LOUDLY and consistently on both
  // the loop and operate paths:
  //   - a first-class `reauth_required` hook → the operate bridge forwards it to
  //     the office (🔑 needs-auth state) and cliExit classifies it directly;
  //   - the GROK_REAUTH_MESSAGE sentinel in the stdout capture → the loop's
  //     AuthDetector raises an AuthError and takes its dedicated reauth PAUSE
  //     (reauth_required webhook + hooks-events line), instead of a generic fail;
  //   - finish(1, 'reauth_required') → cliExit maps it to a NON-retryable
  //     hard-failure (shouldRetryHardFail excludes it), so a missing token is
  //     never hammered with blind retries — the user is asked to re-login.
  const finishReauth = (where: string): void => {
    log(`Grok TUI: reauthentication required — ${where}`);
    _emitGrokHook(root, 'reauth_required', {
      message: GROK_REAUTH_MESSAGE, title: 'Authentication required', tool_name: '',
    });
    try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: ${GROK_REAUTH_MESSAGE}]\n`, 'utf8'); } catch { /* ignore */ }
    finish(1, 'reauth_required');
  };

  void (async () => {
    let sess!: TmuxSession;
    let justLaunched = false;
    let readOffset = 0;
    // Poison-resume self-heal. grok-tui always resumes its stored session; if that
    // resume dies on startup the session is poisoned and resuming it again fails
    // forever. Rather than emit a hard-failure (which the desktop app flags as
    // "Crashed" and STOPS the agent, forcing a manual Restart), clear the poisoned
    // id and relaunch FRESH in place, retrying THIS turn. `sidForLaunch` goes
    // undefined after a clear so ensureSession mints a new UUID instead of resuming
    // the poison again. Only after MAX_STARTUP_TRIES do we surface startup-exit.
    let sidForLaunch = resolvedSessionId;
    const MAX_STARTUP_TRIES = 3;
    let startupOk = false;
    for (let attempt = 1; attempt <= MAX_STARTUP_TRIES; attempt++) {
      try {
        const r = ensureSession(root, sidForLaunch, model, log);
        sess = r.sess; justLaunched = r.justLaunched;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        log(`Grok TUI: session launch failed: ${msg}`);
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI launch error: ${msg}]\n`, 'utf8'); } catch { /* ignore */ }
        finish(1, 'launch-failed');
        return;
      }
      // Stream only THIS turn's output: start reading at the current rawLog size.
      readOffset = (() => { try { return fs.statSync(sess.rawLog).size; } catch { return 0; } })();

      if (!justLaunched) { startupOk = true; break; } // reused live session — no grace

      _emitGrokHook(root, 'SessionStart', { source: 'startup' });
      let died = false;
      let reauth = false;
      // Startup grace — grok's splash takes a few seconds before it accepts input.
      const deadline = Date.now() + STARTUP_MS;
      while (Date.now() < deadline) {
        await sleep(500);
        if (!hasSession(sess.name)) { died = true; break; }
        if (REAUTH_MARKERS.test(capturePane(sess.name))) { reauth = true; break; }
      }
      if (!died && !reauth) {
        // Past the grace with a live session — dismiss any welcome/project picker
        // (Enter through it) or the directory-trust gate (accept with 'y'), until
        // the ready "❯" prompt is clear. CALIBRATED: a NEW grok session opens on a
        // picker over the input box; a single fixed Enter races grok's splash, so
        // poll + press each pass. The trust gate ("Do you trust this directory?")
        // is normally prevented by ensureGrokDirTrusted; this is the backstop.
        const PICKER_MARKERS = /project directory|New worktree|Resume session|Changelog|\(current\)|Run Grok Build|[◯○◉●]|Select|↑\/↓/i;
        const TRUST_MARKERS = /Do you trust|Yes, proceed|posing security risks/i;
        for (let i = 0; i < 8; i++) {
          if (!hasSession(sess.name)) { died = true; break; }
          const snap = capturePane(sess.name);
          if (REAUTH_MARKERS.test(snap)) { reauth = true; break; }
          if (TRUST_MARKERS.test(snap)) {
            // Accept explicitly with 'y' (Enter alone is unreliable depending on
            // which option is highlighted), then keep polling.
            log('Grok TUI: accepting grok directory-trust gate (y)');
            tmux(['send-keys', '-t', sess.name, 'y']);
            await sleep(1200);
            continue;
          }
          if (!PICKER_MARKERS.test(snap)) { break; } // at the ready prompt
          tmux(['send-keys', '-t', sess.name, 'Enter']);
          await sleep(1500);
        }
      }
      if (reauth) {
        finishReauth('auth gate at startup');
        return;
      }
      if (!died) {
        // re-read the offset after startup so the splash/menu text isn't streamed
        // as "turn output".
        readOffset = (() => { try { return fs.statSync(sess.rawLog).size; } catch { return readOffset; } })();
        startupOk = true;
        break;
      }
      // Session died during startup — a poisoned resume (or a storm-starved launch).
      // Clear the stored id, tear down the dead pane, and relaunch FRESH next pass.
      log(`Grok TUI: session died during startup — ${attempt < MAX_STARTUP_TRIES ? `relaunching fresh (attempt ${attempt + 1}/${MAX_STARTUP_TRIES})` : 'giving up this turn'} (poisoned-resume self-heal)`);
      try { clearSessionId(root, 'grok-tui'); } catch { /* best effort */ }
      _tmuxSessions.delete(root);
      try { tmux(['kill-session', '-t', sess.name]); } catch { /* already gone */ }
      sidForLaunch = undefined; // force a fresh mint on the retry
    }
    if (!startupOk) {
      // A session that keeps dying during startup while grok's credentials are
      // ABSENT is an auth failure (silent refresh → Failed(ManualLogin) → exit),
      // not a transient startup race — surface it as reauth so the user re-logs in
      // instead of the loop retrying a login it can never satisfy.
      if (!grokAuthPresent()) {
        finishReauth('auth.json missing — session exited during startup');
        return;
      }
      try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: session kept exiting during startup — a fresh session will be tried next turn]\n`, 'utf8'); } catch { /* ignore */ }
      finish(1, 'startup-exit');
      return;
    }
    // NOTE: when the session is REUSED (not justLaunched) we deliberately emit NO
    // SessionStart. The grok process is persistent across turns — one tmux launch
    // serves many turns — so a per-turn "startup"/SessionStart is semantically
    // false and made the office Events feed show a phantom "startup" every turn,
    // reading as "the grok agent restarts each time" when it does not. A turn
    // boundary is already conveyed by the prompt/task and the tool events.

    // Clean-output source: grok's structured transcript. Seed the offset at the
    // current size so we emit only THIS turn's assistant records, not the
    // resumed history. (File may not exist yet on a fresh session → offset 0.)
    const chatPath = chatHistoryPath(root, sess.sessionId);
    let chatOffset = (() => { try { return fs.statSync(chatPath).size; } catch { return 0; } })();
    let chatEmitted = false;

    // Rich tool-event stream: a SEPARATE offset over the same transcript so each
    // grok tool call becomes one PreToolUse + one PostToolUse (payload-carrying)
    // hook event in the office feed. `pendingTools` matches a Post to its Pre by
    // tool_call id across polls. Seeded at the same size so only THIS turn's tools
    // are emitted, not the resumed history.
    let toolOffset = chatOffset;
    const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();

    // FIX 3 — clean-turn CORROBORATION from grok's OWN events.jsonl (same session
    // dir as chat_history.jsonl). The pane "Worked for N.Ns." DONE_MARKER is
    // calibrated for grok 4.5; grok 4.7's clean turn-end may not print it, so a
    // finished turn could hang until the 45s quiescence fallback — or, if a footer
    // kept matching the running-indicator, run to the watchdog and surface as a
    // FALSE StopFailure (the "finished but shows ❗" bug). grok writes
    // {"type":"turn_ended","outcome":"completed"} on every clean turn end (4.5 AND
    // 4.7). Seed the offset at the current size so we only see THIS turn's records
    // (never a resumed session's prior turn_ended). A clean turn_ended is treated
    // as a positive done-signal (like the pane marker); an error outcome is left to
    // the existing pane/exit detectors. Purely additive — the pane heuristic and
    // its quiescence fallback stay intact as the fallback path.
    const eventsPath = path.join(path.dirname(chatPath), 'events.jsonl');
    let eventsOffset = (() => { try { return fs.statSync(eventsPath).size; } catch { return 0; } })();
    let sawCleanTurnEnd = false;
    const drainEventsForTurnEnd = (): void => {
      let size = 0;
      try { size = fs.statSync(eventsPath).size; } catch { return; }
      if (size <= eventsOffset) { return; }
      let raw = '';
      try {
        const len = size - eventsOffset;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(eventsPath, 'r');
        try { fs.readSync(fd, buf, 0, len, eventsOffset); } finally { fs.closeSync(fd); }
        raw = buf.toString('utf8');
      } catch { return; }
      const lastNl = raw.lastIndexOf('\n');
      if (lastNl < 0) { return; } // no complete line yet
      const complete = raw.slice(0, lastNl);
      eventsOffset += Buffer.byteLength(complete, 'utf8') + 1;
      if (scanGrokTurnEnd(complete.split('\n')) === 'clean') { sawCleanTurnEnd = true; }
    };

    // Submit the prompt.
    log(`Grok TUI: sending turn (${(() => { try { return fs.statSync(promptFilePath).size; } catch { return 0; } })()} bytes)`);
    pastePrompt(sess, promptFilePath);

    // -----------------------------------------------------------------------
    // Poll: stream new pane bytes, detect turn-end by output quiescence + a
    // byte-stable pane snapshot with the running-indicator absent.
    // -----------------------------------------------------------------------
    const turnStart = Date.now();
    let lastGrowthMs = Date.now();
    let sawOutput = false;
    let lastSnap = '';
    let stable = 0;
    let sawDoneMarker = false;

    for (;;) {
      await sleep(POLL_MS);

      // Session died mid-turn (grok crashed / was killed).
      if (!hasSession(sess.name)) {
        _tmuxSessions.delete(root);
        // A mid-turn death with grok's credentials ABSENT is the proven
        // auth-failure signature (auth.json vanished → silent refresh failed →
        // grok exited). Surface it as reauth, not a generic session-exit, so the
        // user is asked to re-login instead of the turn being retried blindly.
        if (!grokAuthPresent()) {
          finishReauth('auth.json missing — grok exited mid-turn');
          return;
        }
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: session exited]\n`, 'utf8'); } catch { /* ignore */ }
        finish(1, 'session-exit');
        return;
      }

      // 1a) Read the pane ONLY for activity/quiescence timing — its bytes are
      //     TUI chrome (spinners, "Waiting for response…", token counters) and
      //     must NOT be emitted as the agent's output.
      const { text: paneText, offset: paneOff } = readFrom(sess.rawLog, readOffset);
      if (paneText) {
        readOffset = paneOff;
        sess.readOffset = paneOff;
        if (stripAnsi(paneText).trim()) {
          _lastActivityMs.set(root, Date.now());
          lastGrowthMs = Date.now();
          sawOutput = true;
        }
      }

      // 1b) Emit CLEAN output from grok's structured transcript (assistant prose
      //     + compact tool markers), never the pane scrape.
      const ch = drainChatHistory(chatPath, chatOffset);
      if (ch.text) {
        chatOffset = ch.offset;
        chatEmitted = true;
        try { fs.appendFileSync(stdoutFile, ch.text, 'utf8'); } catch { /* ignore */ }
        emitLines(ch.text);
        activityBuf += ch.text; scheduleActivity();
        _lastActivityMs.set(root, Date.now());
      }

      // 1c) Emit rich per-tool hook events (Pre/PostToolUse with payload) from the
      //     SAME transcript, on an independent offset.
      toolOffset = scanGrokToolEvents(root, chatPath, toolOffset, pendingTools);

      // 2) Snapshot for detection (also catches a mid-turn auth failure and
      //    grok's native "Turn failed: Grok stopped before this turn finished"
      //    banner). classifyGrokTurn disambiguates the two using the pane text +
      //    grok's credential-file presence:
      //      - 'reauth'      → auth gate / Failed(ManualLogin) / a turn-failure
      //        while auth.json is absent → surface reauth (NEVER retried).
      //      - 'turn-failed' → grok's process blipped mid-turn with credentials
      //        present → a TRANSIENT hard-failure that IS retried with backoff by
      //        the loop (shouldRetryHardFail treats it as retryable). Previously
      //        this banner had no detector, so the pane went quiet and the turn
      //        was misread as a clean idle (a FALSE success that lost the task).
      const snap = capturePane(sess.name);
      // Drain grok's own events.jsonl FIRST so a confirmed clean turn_ended can
      // veto a pane-scraped false 'turn-failed' below (FIX 3). A clean turn_ended
      // means grok finished the turn cleanly — grok never writes it after a real
      // mid-turn process blip — so a lingering pane banner must not force a
      // StopFailure. reauth is NEVER vetoed (a missing login is real regardless).
      drainEventsForTurnEnd();
      const turnClass = classifyGrokTurn(snap, grokAuthPresent());
      if (turnClass === 'reauth') {
        finishReauth('auth failure detected mid-turn');
        return;
      }
      if (turnClass === 'turn-failed' && !sawCleanTurnEnd) {
        log('Grok TUI: grok reported a turn failure (transient) — surfacing for retry');
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: turn failed — grok stopped before this turn finished (transient); the loop will retry]\n`, 'utf8'); } catch { /* ignore */ }
        finish(1, 'turn-failed');
        return;
      }
      // Backstop: the project-directory picker appears AFTER the first prompt is
      // submitted (grok's one-time confirm), so it lands mid-turn. The config
      // opt-out normally prevents it; if a grok build ignores that, select the
      // current dir (option "1", always present) to unblock the turn.
      if (/Run Grok Build in a project directory|Don't ask me again|\(current\)/i.test(snap)) {
        tmux(['send-keys', '-t', sess.name, '1']);
        await sleep(800);
        lastGrowthMs = Date.now();
        continue;
      }

      // 3) Idle test. grok prints "Worked for N.Ns." when a turn genuinely ends —
      //    that's the fast, positive done-signal. Absent it (an error turn, or an
      //    unusual grok build), fall back to a MUCH longer quiescence so early
      //    "Starting session…"/"Reading file…" pauses aren't misread as turn-end.
      if (DONE_MARKER.test(snap)) { sawDoneMarker = true; }
      // events.jsonl was drained above (before the turn-failed check). A clean
      // {"turn_ended","completed"} this turn is a build-agnostic positive
      // done-signal (recognizes grok 4.7's clean finish, which may omit the
      // grok-4.5 pane marker) → treat it exactly like the pane marker so the turn
      // ends cleanly + fast as finish(0)=Stop instead of hanging to the quiescence
      // fallback or the watchdog StopFailure.
      if (sawCleanTurnEnd) { sawDoneMarker = true; }
      if (snap === lastSnap) { stable++; } else { stable = 0; lastSnap = snap; }
      const running = RUNNING_INDICATOR.test(snap);
      const quietMs = Date.now() - lastGrowthMs;
      const readyToJudge = sawOutput || (Date.now() - turnStart >= NOOUTPUT_MS);
      // A clean events.jsonl turn_ended is authoritative that grok finished — allow
      // it to end the turn even if a stale footer still matches the running-indicator
      // (grok 4.7 can leave a "Ctrl+c"-style footer painted after a completed turn),
      // gated on the same DEBOUNCE_MS quiet window so trailing output still flushes.
      const doneFast = sawDoneMarker && quietMs >= DEBOUNCE_MS;
      const doneSlow = readyToJudge && quietMs >= QUIET_FALLBACK_MS && stable >= STABLE_POLLS;
      // grok's own log confirmed a clean turn_ended → end even if a stale footer
      // still trips the running-indicator (still gated on the quiet window so
      // trailing transcript records flush first).
      const doneClean = sawCleanTurnEnd && quietMs >= DEBOUNCE_MS;
      if (doneClean || (!running && (doneFast || doneSlow))) {
        // Final drain of the transcript to catch records written between the last
        // poll and turn-end.
        const tail = drainChatHistory(chatPath, chatOffset);
        if (tail.text) {
          chatOffset = tail.offset; chatEmitted = true;
          try { fs.appendFileSync(stdoutFile, tail.text, 'utf8'); } catch { /* ignore */ }
          emitLines(tail.text);
        }
        // Flush any tool events written between the last poll and turn-end.
        toolOffset = scanGrokToolEvents(root, chatPath, toolOffset, pendingTools);
        // Safety net: if the transcript path never resolved (grok layout change /
        // encoding drift) yet the pane clearly produced output, fall back to a
        // cleaned pane tail so the turn is never silently empty.
        if (!chatEmitted && sawOutput) {
          const pane = stripAnsi(capturePane(sess.name, 400)).replace(/[ \t]+\n/g, '\n').trim();
          if (pane) { try { fs.appendFileSync(stdoutFile, pane + '\n', 'utf8'); } catch { /* ignore */ } }
          log('Grok TUI: transcript yielded no output — fell back to pane capture (check chat_history path)');
        }
        finish(0, 'idle');
        return;
      }

      // 4) Watchdog — a turn that overruns the hard budget. Interrupt with Esc
      //    (grok's cancel) to preserve the session/context; if it won't settle,
      //    kill the session so the NEXT turn relaunches with --resume.
      if (MAX_RUN_MS > 0 && Date.now() - turnStart >= MAX_RUN_MS) {
        log(`Grok TUI watchdog: exceeded ${Math.round(MAX_RUN_MS / 60_000)}min budget — interrupting`);
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI watchdog: turn exceeded time budget — interrupted]\n`, 'utf8'); } catch { /* ignore */ }
        tmux(['send-keys', '-t', sess.name, 'Escape']);
        // Give grok a moment to settle after the interrupt.
        let settled = false;
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          if (!hasSession(sess.name)) { break; }
          const s2 = capturePane(sess.name);
          if (!RUNNING_INDICATOR.test(s2)) { settled = true; break; }
        }
        if (!settled && hasSession(sess.name)) {
          // Still wedged after Esc → kill so ensureSession relaunches next turn.
          killSession(sess.name);
          _tmuxSessions.delete(root);
        }
        finish(124, 'watchdog');
        return;
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Headless runner (grok-cli always; grok-tui fallback when tmux is missing).
// Fire-and-forget: spawns grok with --prompt-file, streams streaming-json to
// stdoutFile, writes exit code to exitFile when the process exits.
// ---------------------------------------------------------------------------
interface GrokRunOptions {
  model?: string;
  showOutput?: () => void;
  /** grok-tui: resume/continue a session so context accumulates across tasks. */
  persist?: boolean;
  sessionId?: string;
  /**
   * Resume the MOST RECENT grok session for this cwd via `grok --continue` (grok's
   * "-c, --continue" = continue the most recent session for the current working
   * directory). This is ROBUST to id/tracking drift: an explicit `--resume <id>`
   * errors instantly on the user's Windows grok when the stored id can't be matched
   * for the cwd (a stale id, or a cwd-encoding mismatch), so every turn fell back to
   * stateless. `--continue` lets grok pick the folder's newest session itself.
   * MUST NOT be combined with `--session-id` (grok rejects that unless --fork-session,
   * which we do NOT want) or with `sessionId`.
   */
  continueSession?: boolean;
  providerId?: ProviderId;
  /**
   * Headless grok-tui resume hang-probe. When > 0 (with `onResumeHang`), watch
   * grok's events.jsonl for a `first_token` within this many ms; if none appears
   * (the grok 1.0.41 headless `--resume` hang: loaded-but-never-answers), kill
   * this grok WITHOUT writing the exit file and invoke `onResumeHang` so the
   * caller relaunches THIS turn stateless. A first_token (or any turn_ended) makes
   * the probe a no-op and the turn runs normally. Must stay under the watchdog.
   */
  resumeProbeMs?: number;
  onResumeHang?: () => void;
  /**
   * Fired ONCE when a launched RESUME (opts.sessionId present) demonstrably begins
   * answering — the first `first_token`. Lets the caller clear its consecutive-resume-
   * failure counter so a prior transient hiccup does not keep biasing later turns.
   */
  onResumeOk?: () => void;
}

/**
 * Pure builder for the grok session CLI flags, extracted so the mutually-exclusive
 * invariants are unit-testable without spawning grok:
 *   - continueSession → `['--continue']` ONLY. NEVER with `--session-id` (grok rejects
 *     that combo unless `--fork-session`, which we never pass) and never an explicit id.
 *   - sessionId       → `['--resume', <id>]` (legacy explicit-id resume; not used by the
 *     headless path anymore, kept for callers that pass a concrete id).
 *   - newSessionId    → `['--session-id', <uuid>]` (bootstrap a brand-new named session).
 *   - none            → `[]` (stateless: grok mints its own throwaway id).
 * continueSession takes precedence, so `--continue` can never be emitted alongside an id.
 */
export function grokSessionArgsFor(
  args: { continueSession?: boolean; sessionId?: string; newSessionId?: string },
): string[] {
  if (args.continueSession) { return ['--continue']; }
  if (args.sessionId) { return ['--resume', args.sessionId]; }
  if (args.newSessionId) { return ['--session-id', args.newSessionId]; }
  return [];
}

export function sendGrokPrompt(
  root: string,
  promptFilePath: string,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  opts: GrokRunOptions = {},
): void {
  opts.showOutput?.();

  const modelArgs = opts.model ? ['-m', opts.model] : [];
  const modelLabel = opts.model || 'account default';

  const sessionArgs: string[] = [];
  // The concrete grok session id this launch will read/append to, when known:
  //   • resume        → opts.sessionId (`--resume <id>`)
  //   • new-persistent → the freshly-minted `--session-id <sid>`
  //   • stateless      → undefined (grok mints an unknown id; newest-by-mtime only)
  // Used to seed + TAIL the FIXED session dir (grokSessionDirFor) instead of
  // "newest-by-mtime", so a newer UNRELATED session dir on disk can never divert
  // the tailer or reset its byte offset to 0 (→ a prior turn's stale `turn_ended`
  // read from the start = an instant false failure). This is the primary fix for
  // the 1.4.181 forced-resume regression.
  let _launchSid: string | undefined;
  // For the `--continue` path the concrete id is not known up front — grok appends to
  // the cwd's most-recent session dir — so we pin the tailer to that EXISTING newest
  // dir (resolved at launch, before grok appends). Kept separate from _launchSid (which
  // means "we minted/passed this exact id"), since --continue passes no id at all.
  let _continueDir: string | undefined;
  if (opts.persist) {
    const providerId = opts.providerId ?? 'grok-tui';
    if (opts.continueSession) {
      // `grok --continue`: resume the folder's most-recent session. No id, and NO
      // --session-id (grok rejects that combo unless --fork-session, which we never
      // want). Robust to the stale-id / cwd-tracking-drift that made `--resume <id>`
      // error in ~1s on Windows and forced every turn stateless.
      sessionArgs.push(...grokSessionArgsFor({ continueSession: true }));
      _continueDir = newestGrokSessionDir(path.resolve(root));
      // Best-effort: stamp the resolved id into session-state.json so the sessions UI
      // / resume-aware profile reminder can still name the session. The continue
      // DECISION no longer depends on a stored id (it keys off folder-session presence).
      try {
        const resumedId = _continueDir ? path.basename(_continueDir) : undefined;
        if (resumedId) { saveSessionId(root, providerId, resumedId); }
      } catch { /* best effort */ }
      log(`Grok: continuing most-recent session for cwd (--continue) (model=${modelLabel})`);
    } else if (opts.sessionId) {
      sessionArgs.push(...grokSessionArgsFor({ sessionId: opts.sessionId }));
      _launchSid = opts.sessionId;
      // Persist the id we're resuming so the NEXT turn reads it from
      // session-state.json directly — this also stamps a session that was only
      // resolved via disk-detection (getGrokLatestSessionId) into the state file,
      // making the resume chain stable turn-over-turn. Idempotent.
      try { saveSessionId(root, providerId, opts.sessionId); } catch { /* best effort */ }
      log(`Grok: resuming session ${opts.sessionId.slice(0, 8)}… (model=${modelLabel})`);
    } else {
      const sid = randomUUID();
      sessionArgs.push(...grokSessionArgsFor({ newSessionId: sid }));
      _launchSid = sid;
      try { saveSessionId(root, providerId, sid); } catch { /* best effort */ }
      log(`Grok: new persistent session ${sid.slice(0, 8)}… (model=${modelLabel})`);
    }
  } else {
    log(`Grok: spawning (model=${modelLabel})`);
  }

  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  const prior = _activeChildren.get(root);
  if (prior) {
    if (prior.pid) { killProcessTree(prior.pid); }
    try { prior.kill('SIGKILL'); } catch { /* ignore */ }
    _activeChildren.delete(root);
  }

  _busyRoots.add(root);

  const failSpawn = (msg: string): void => {
    log(`Grok spawn error: ${msg}`);
    try { fs.appendFileSync(stdoutFile, `\n[Grok spawn error: ${msg}]\n`, 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
    _activeChildren.delete(root);
    _busyRoots.delete(root);
  };

  let child: child_process.ChildProcess;
  try {
    child = child_process.spawn(
      GROK_BIN,
      [
        ...modelArgs,
        '--always-approve',
        '--cwd', root,
        ...sessionArgs,
        '--prompt-file', promptFilePath,
        '--output-format', 'streaming-json',
      ],
      {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        // Give slow MCP servers time to start (grok's default is 30s). Honor a
        // pre-existing value; otherwise apply the default. Grok ignores
        // config.toml's startup_timeout_sec — this env var is the real knob.
        env: {
          ...process.env,
          GROK_MCP_STARTUP_TIMEOUT_SECS:
            process.env['GROK_MCP_STARTUP_TIMEOUT_SECS'] || String(MCP_STARTUP_TIMEOUT_DEFAULT_SEC),
        },
      },
    );
  } catch (spawnErr) {
    failSpawn((spawnErr as Error)?.message ?? String(spawnErr));
    return;
  }

  child.on('error', (err: Error) => {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    failSpawn(missing
      ? `${GROK_BIN} is not installed or not on PATH (${err.message})`
      : err.message);
  });

  _activeChildren.set(root, child);
  child.once('spawn', () => { _emitGrokHook(root, 'SessionStart', { source: 'startup' }); });

  // Default 20min (was 10). The headless resume hang-probe can now wait patiently up
  // to ~6.7min (90s + 15 exponential extensions, gated on real per-round progress) for
  // a first token under heavy startup contention (~17 grok agents serialize on grok's
  // shared session index). The watchdog MUST comfortably exceed that worst-case probe
  // total PLUS a real work budget, or a slow-but-alive resume would be killed before it
  // could do any work. 400s probe worst-case + ≥13min work budget < 1200s watchdog.
  const GROK_MAX_RUN_MS      = envNum('AUTODEV_GROK_MAX_RUN_MS', 20 * 60_000);
  const GROK_MAX_TOOL_ERRORS = envNum('AUTODEV_GROK_MAX_TOOL_ERRORS', 25);
  let toolErrorCount = 0;
  let killed = false;
  const killGrok = (why: string): void => {
    if (killed) { return; }
    killed = true;
    log(`Grok watchdog: ${why} — killing run`);
    try { fs.appendFileSync(stdoutFile, `\n[Grok watchdog: ${why}]\n`, 'utf8'); } catch { /* ignore */ }
    if (child.pid) { killProcessTree(child.pid); }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  };
  const watchdog = GROK_MAX_RUN_MS > 0
    ? setTimeout(() => killGrok(`exceeded ${Math.round(GROK_MAX_RUN_MS / 60_000)}min time budget`), GROK_MAX_RUN_MS)
    : null;

  // ── Turn-end + activity from grok's OWN session logs (HEADLESS path) ────────
  // grok's `--output-format streaming-json` stdout no longer emits the per-tool /
  // per-message / `end` records this runner's rl parser expected (format drift on
  // grok 4.7): a HEADLESS loop turn (Windows — no tmux → this spawn) therefore
  // forwarded only Session*/Stop* boundaries (NO tool calls, NO narration) AND
  // never saw a turn-end — so a FINISHED grok-4.7 turn (which omits the grok-4.5
  // "Worked for Ns" pane marker) ran to the 10-min watchdog and surfaced as a
  // false StopFailure→retry loop. Mirror the 1.4.175 operate bridge + tmux FIX 3:
  // tail grok's session events.jsonl (native tool calls + turn_ended) and
  // chat_history.jsonl (assistant narration) by byte offset during the turn,
  // append the office hook events to the loop's own .autodev/hooks-events.jsonl
  // channel, and finish PROMPTLY on a clean turn_ended. Never throws / never
  // blocks; a no-op until the session dir resolves.
  let _endSeen = false;
  let _grokReauthEmitted = false;          // reauth_required already surfaced this turn (never double-emit / retry)
  let _forcedExit: number | null = null;   // set by a session-log turn_ended finish
  let _grokFilesActive = false;            // once true, session logs own narration
  // Best diagnostic grok gave us THIS turn, so a fast-failing resume/continue is no
  // longer a blind guess (the user's Windows `--resume <id>` errors in ~1s but our log
  // never showed grok's real reason). Populated from three channels: an authoritative
  // streaming-json {type:"error"} record or an error turn_ended detail (_lastGrokErr),
  // and, as a fallback, the most recent stderr line (_lastGrokStderr). Surfaced right
  // before the stateless fallback in finishFromTurnEnd, redacted + truncated.
  let _lastGrokErr = '';                    // authoritative: json error record / error turn_ended detail
  let _lastGrokStderr = '';                 // fallback: latest non-empty stderr line
  const grokFailDiag = (): string => {
    const raw = _lastGrokErr || _lastGrokStderr;
    if (!raw) { return ''; }
    const t = redactSecrets(String(raw)).replace(/\s+/g, ' ').trim();
    return t.length > 300 ? t.slice(0, 297) + '…' : t;
  };
  // Headless resume hang-probe state (see resumeProbeMs / onResumeHang below). The
  // probe window is the caller-supplied value (sendGrokTuiPrompt reads the env);
  // 0 (all stateless / non-probed calls) leaves the probe disarmed.
  const RESUME_PROBE_MS = Math.max(0, opts.resumeProbeMs ?? 0);
  // Exponential, multi-round probe backoff (1.4.185). After the first RESUME_PROBE_MS
  // window, grant up to RESUME_MAX_EXT further windows, each waiting an EXPONENTIALLY
  // growing interval (base × 2^(round-1), capped), but ONLY while grok keeps writing
  // NEW session events (real progress) and has not yet emitted first_token. This makes
  // resume patient with a slow-but-alive load (~17 agents serialize on grok's shared
  // session index → a resume can legitimately take minutes) yet fast to abandon a truly
  // silent/hung one. Worst-case total = 90s + Σ extensions ≈ 6.7min, safely < the 20min
  // watchdog. All env-overridable.
  const RESUME_MAX_EXT       = Math.max(0, envNum('AUTODEV_GROK_RESUME_MAX_EXTENSIONS', 15));
  const RESUME_EXT_BASE_MS   = Math.max(1000, envNum('AUTODEV_GROK_RESUME_EXT_BASE_MS', 8_000));
  const RESUME_EXT_CAP_MS    = Math.max(RESUME_EXT_BASE_MS, envNum('AUTODEV_GROK_RESUME_EXT_CAP_MS', 22_000));
  const RESUME_EXT_FACTOR    = 2;
  let _sawFirstToken = false;              // grok emitted first_token → resume works
  let _grokWroteEvents = false;            // grok appended ANY session events this turn (loaded + active)
  let _grokEventWrites = 0;                // monotonic count of NEW session-event lines drained this turn (per-round progress marker)
  let _resumeAbandoned = false;            // probe killed this grok; a stateless relaunch owns the turn
  const _grokEmittedIds = _emittedToolIds.get(root) ?? (() => { const s = new Set<string>(); _emittedToolIds.set(root, s); return s; })();
  const _grokSize = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  // The FIXED session dir this turn reads/appends to, when a concrete id is known
  // (resume OR new-persistent). grok writes to <base>/<encodeURIComponent(cwd)>/<id>,
  // and grok is launched with `--cwd root` — resolve exactly as newestGrokSessionDir
  // does (path.resolve) so the encoding matches what grok writes on disk. When set,
  // the tailer pins THIS dir and never "newest-by-mtime" (which a newer unrelated
  // session dir could hijack). undefined only in the stateless mode, where grok
  // mints an unknown id and newest-by-mtime is the only way to find it.
  // --continue → the existing newest dir grok appends to (resolved above); resume /
  // new-persistent → the fixed dir for the known id; stateless → undefined (unknown id).
  const _fixedDir: string | undefined = _continueDir
    ?? (_launchSid ? grokSessionDirFor(path.resolve(root), _launchSid) : undefined);
  // Snapshot the pre-turn session so the tailer forwards ONLY this turn's records:
  // a RESUMED session's dir already holds backlog → seed at its current end; a
  // FRESH session mints a NEW dir that appears later → read that dir from the start
  // (its files don't exist yet → size 0 → read from 0 once grok creates them).
  let _seedDir = ''; let _seedEvOff = 0; let _seedChOff = 0;
  try {
    const d = _fixedDir ?? newestGrokSessionDir(root);
    if (d) { _seedDir = d; _seedEvOff = _grokSize(path.join(d, 'events.jsonl')); _seedChOff = _grokSize(path.join(d, 'chat_history.jsonl')); }
  } catch { /* no prior session — a fresh dir reads from 0 */ }
  let _grokDir: string | null = null;
  let _evOff = 0; let _chOff = 0;
  let _sawTurnStart = false;               // this turn's turn_started/loop_started/first_token seen in the tailed window

  const rl = readline.createInterface({ input: child.stdout! });

  let _activityBuf = '';
  let _activityTimer: ReturnType<typeof setTimeout> | null = null;
  const flushActivity = (): void => {
    if (_activityTimer) { clearTimeout(_activityTimer); _activityTimer = null; }
    const t = _activityBuf.trim();
    _activityBuf = '';
    // Once grok's session logs are being tailed they OWN the narration bubbles
    // (clean prose from chat_history.jsonl); don't ALSO emit the stdout scrape or
    // the same narration renders twice. Fallback stays live until then.
    if (!t || _grokFilesActive) { return; }
    const preview = t.length > 280 ? t.slice(0, 277) + '…' : t;
    _emitGrokHook(root, 'Notification', { message: preview, title: 'grok', tool_name: 'grok' });
  };
  const scheduleActivity = (): void => {
    if (_activityBuf.length >= 400) { flushActivity(); return; }
    if (!_activityTimer) { _activityTimer = setTimeout(flushActivity, 1200); }
  };

  let _lineBuf = '';
  const emitOutputLines = (text: string): void => {
    _lineBuf += text;
    let nl: number;
    while ((nl = _lineBuf.indexOf('\n')) >= 0) {
      const line = _lineBuf.slice(0, nl).replace(/\s+$/, '');
      _lineBuf = _lineBuf.slice(nl + 1);
      if (line.trim()) { log(`  ${line}`); }
    }
  };
  const flushOutputLine = (): void => {
    const line = _lineBuf.replace(/\s+$/, '');
    _lineBuf = '';
    if (line.trim()) { log(`  ${line}`); }
  };

  // Clean/early finish driven by grok's session-log turn_ended (see block above).
  // Emits the turn-end boundary hooks ONCE, forces the reported exit code so a
  // SIGKILL is not misread as a failure, then kills the (often hung) grok process
  // so `close` writes the exit file promptly.
  const finishFromTurnEnd = (clean: boolean): void => {
    if (_endSeen || killed) { return; }
    // AUTH failure short-circuit: grok is NOT signed in (token expired / auth.json
    // gone → "Not signed in … grok login --device-code" / XAI_API_KEY). This can
    // NEVER be retried or relaunched away, so surface reauth_required and STOP —
    // BEFORE the resume-hang stateless relaunch below (which would just re-hit the
    // same logged-out gate) or a retryable StopFailure. The stdout sentinel also
    // makes the loop's AuthDetector raise its dedicated reauth PAUSE.
    if (!clean && !_grokReauthEmitted && isGrokAuthFailure(grokFailDiag())) {
      _grokReauthEmitted = true;
      _endSeen = true;
      _forcedExit = 1;
      flushOutputLine();
      flushActivity();
      _emitGrokReauthHook(root, stdoutFile, log, 'headless turn failed (not signed in)', opts.providerId ?? 'grok-tui', grokFailDiag());
      if (grokFilePoll) { clearInterval(grokFilePoll); }
      if (watchdog) { clearTimeout(watchdog); }
      if (resumeProbeTimer) { clearTimeout(resumeProbeTimer); resumeProbeTimer = null; }
      killed = true;
      if (child.pid) { killProcessTree(child.pid); }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      return;
    }
    // Recovery: a RESUME turn that ERRORED before producing any real output (no
    // first_token) means the resume itself is broken (grok 1.0.41's `--resume`
    // failing fast, a poisoned/stale session, or any unrecoverable resume error).
    // Reporting a task failure here would just re-resume the SAME broken session
    // next turn → the infinite `retry 1/10` loop. Instead, reuse the resume
    // hang-probe's machinery: count ONE transient resume failure (bounded, NOT a
    // permanent poison) and relaunch THIS turn stateless so the task completes. The
    // STORED session id is preserved (stateless uses persist:false), so the next turn
    // re-attempts `--resume <storedId>` — continuity resumes as soon as the transient
    // condition clears. Only for a launched RESUME (opts.sessionId present, probe
    // armed); a new-persistent/stateless error falls through to the normal report.
    if (!clean && !_sawFirstToken && (opts.sessionId || opts.continueSession) && opts.onResumeHang && !_resumeAbandoned) {
      _resumeAbandoned = true;       // close skips the exit file — the relaunch owns the turn
      const how = opts.continueSession ? '--continue' : '--resume';
      const diag = grokFailDiag();
      if (diag) { log(`Grok: ${how} failed fast — grok said: "${diag}"`); }
      else { log(`Grok: ${how} failed fast — grok emitted no diagnostic (no stderr / error record captured this turn)`); }
      log('Grok: resume errored before any output (no first_token) — marking session non-resumable this run, falling back to stateless for this turn');
      if (grokFilePoll) { clearInterval(grokFilePoll); }
      if (watchdog) { clearTimeout(watchdog); }
      if (resumeProbeTimer) { clearTimeout(resumeProbeTimer); resumeProbeTimer = null; }
      killed = true;                 // suppress the watchdog's own kill/report
      if (child.pid) { killProcessTree(child.pid); }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      try { opts.onResumeHang(); } catch (e) { log(`Grok: stateless relaunch after broken resume failed: ${(e as Error)?.message ?? String(e)}`); }
      return;
    }
    _endSeen = true;                 // suppress close's boundary re-emit
    _forcedExit = clean ? 0 : 1;     // report the true outcome, not the SIGKILL code
    flushOutputLine();
    flushActivity();
    if (clean) {
      log('Grok: clean turn_ended in session log — ending turn (Stop)');
      _emitGrokHook(root, 'Stop', {});
      _emitGrokHook(root, 'SessionEnd', { reason: 'completed' });
    } else {
      log('Grok: error turn_ended in session log — ending turn (retryable)');
      _emitGrokHook(root, 'StopFailure', { exit_code: 1 });
      _emitGrokHook(root, 'SessionEnd', { reason: 'error' });
    }
    killed = true;                   // beat the watchdog to the kill (no double-report)
    if (child.pid) { killProcessTree(child.pid); }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  };

  const pumpGrokSessionFiles = (): void => {
    if (_endSeen || killed) { return; }
    let dir: string | undefined;
    // When a concrete session id is known, TAIL THAT FIXED DIR — a newer unrelated
    // session dir on disk can never divert the tailer or reset its offset. Only the
    // stateless mode (unknown id) falls back to newest-by-mtime.
    if (_fixedDir) { dir = _fixedDir; }
    else { try { dir = newestGrokSessionDir(root); } catch { dir = undefined; } }
    if (!dir) { return; }                 // no session dir yet — nothing to tail
    const evFile = path.join(dir, 'events.jsonl');
    const chFile = path.join(dir, 'chat_history.jsonl');
    if (dir !== _grokDir) {
      _grokDir = dir;
      if (dir === _seedDir) { _evOff = _seedEvOff; _chOff = _seedChOff; } // skip pre-turn backlog
      else { _evOff = 0; _chOff = 0; }                                    // fresh turn dir → read all
    }
    _grokFilesActive = true;              // session logs now own narration
    const ev = drainNewJsonlLines(evFile, _evOff); _evOff = ev.offset;
    const ch = drainNewJsonlLines(chFile, _chOff); _chOff = ch.offset;
    if (ev.lines.length) { _grokWroteEvents = true; _grokEventWrites += ev.lines.length; } // grok is writing → loaded + active (not a dead-load hang); counter is the per-round progress marker
    // Resume hang-probe signal: grok emitted first_token → the (resumed) prompt is
    // being answered, so the probe below leaves the turn to run normally. On a RESUME
    // launch this is also proof the resume succeeded → clear the failure counter so a
    // prior transient hiccup stops biasing later turns.
    if (!_sawFirstToken && scanGrokFirstToken(ev.lines)) {
      _sawFirstToken = true;
      if ((opts.sessionId || opts.continueSession) && opts.onResumeOk) { try { opts.onResumeOk(); } catch { /* best effort */ } }
    }
    // Turn-start signal: THIS turn has demonstrably begun in the tailed window
    // (turn_started/loop_started/first_token). A trailing turn_ended is only the
    // current turn's result once we have seen the start — otherwise it is backlog.
    if (!_sawTurnStart && scanGrokTurnStart(ev.lines)) { _sawTurnStart = true; }
    // Forward native tool calls + assistant narration (mcp__/office tools skipped,
    // deduped per-root by tool_call id, secret-redacted before it leaves the box).
    for (const h of grokLoopForwardHooks(ev.lines, ch.lines, _grokEmittedIds)) {
      if (h.hook_event_name === 'Notification') {
        const msg = redactSecrets(String(h.message || '')).slice(0, 1200);
        if (msg.trim()) { _emitGrokHook(root, 'Notification', { message: msg, title: 'grok', tool_name: 'grok' }); }
      } else {
        const extra: Record<string, unknown> = { tool_name: h.tool_name };
        if (h.tool_use_id) { extra['tool_use_id'] = h.tool_use_id; }
        if (h.outcome) { extra['outcome'] = h.outcome; }
        _emitGrokHook(root, h.hook_event_name, redactDeep(extra));
      }
    }
    // FIX 3 parity for HEADLESS: a clean turn_ended is a build-agnostic positive
    // done-signal (grok 4.7 omits the grok-4.5 pane marker), so end the turn NOW
    // instead of hanging to GROK_MAX_RUN_MS. An error/aborted outcome ends it too
    // (retryable), honoring scanGrokTurnEnd's classification.
    const te = scanGrokTurnEnd(ev.lines);
    // Capture grok's own error detail from an error turn_ended so the fast-fail
    // fallback can name WHY (session-not-found, in-use, cwd mismatch, auth, …). Only
    // when we don't already have an authoritative streaming-json error record.
    if (te === 'error' && !_lastGrokErr) {
      for (const l of ev.lines) {
        let o: any; try { o = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
        if (!o || o.type !== 'turn_ended') { continue; }
        const d = o.error?.message ?? o.error ?? o.detail ?? o.message ?? o.reason ?? o.outcome_detail;
        if (d) { _lastGrokErr = typeof d === 'string' ? d : JSON.stringify(d); break; }
      }
    }
    // Safety net against any residual offset skew: only honor a turn_ended once
    // THIS turn has demonstrably started in the tailed window. A turn_ended with no
    // preceding current-turn start is backlog (a prior errored turn read from a
    // stale offset) → ignore it; the offset has already advanced past it.
    if (te && (_sawTurnStart || _sawFirstToken)) {
      if (te === 'clean') { finishFromTurnEnd(true); }
      else { finishFromTurnEnd(false); }
    }
  };
  const GROK_FILE_POLL_MS = envNum('AUTODEV_GROK_FILE_POLL_MS', 900);
  const grokFilePoll = GROK_FILE_POLL_MS > 0 ? setInterval(pumpGrokSessionFiles, GROK_FILE_POLL_MS) : null;
  grokFilePoll?.unref?.();

  // ── Headless resume hang-probe ──────────────────────────────────────────────
  // grok 1.0.41's headless `--resume` can LOAD the session (stays alive, writes
  // turn_started/phase_changed) yet never answer → the 10-min watchdog → false
  // StopFailure. When armed (resumeProbeMs > 0 + onResumeHang, i.e. a persistent
  // grok-tui launch), fire ONE timer at resumeProbeMs: a first_token by then means
  // the resumed prompt is being processed (leave the turn running); NO first_token
  // means the hang — kill this grok WITHOUT writing the exit file and hand the SAME
  // turn to a fresh stateless relaunch (onResumeHang), so the task still completes.
  // A turn_ended handled by pumpGrokSessionFiles (clean or error) sets _endSeen/killed
  // first, making the probe a no-op. Worst-case cumulative wait (~6.7min) stays safely
  // under MAX_RUN_MS (20min) so it never races the watchdog.
  let resumeProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let _probeRound = 0;                     // extensions granted so far (0 = still on the first window)
  let _probeWriteMark = 0;                 // _grokEventWrites snapshot when the CURRENT window was armed
  let _probeWaitedMs = 0;                  // cumulative probe wait so far (for honest logging)
  if (RESUME_PROBE_MS > 0 && opts.onResumeHang) {
    // Interval for extension round k (1-indexed): base × factor^(k-1), capped.
    const extIntervalMs = (round: number): number =>
      Math.min(RESUME_EXT_CAP_MS, Math.round(RESUME_EXT_BASE_MS * Math.pow(RESUME_EXT_FACTOR, round - 1)));
    const armProbe = (waitMs: number): void => {
      _probeWriteMark = _grokEventWrites;  // snapshot the per-round progress marker for THIS window
      resumeProbeTimer = setTimeout(() => {
        // Final drain to catch a first_token / turn_ended written between polls.
        try { pumpGrokSessionFiles(); } catch { /* best effort */ }
        if (_endSeen || killed || _resumeAbandoned) { return; } // turn already resolved
        _probeWaitedMs += waitMs;
        // PROGRESS-GATED extension: did grok write NEW session events during THIS window?
        // (not merely "ever wrote") — a fully silent window with no first_token is the
        // genuine hang and falls back immediately, so a dead process never burns the
        // whole ~6.7min budget.
        const grewSinceLastCheck = _grokEventWrites > _probeWriteMark;
        const verdict = resumeProbeVerdict({
          sawFirstToken: _sawFirstToken, elapsedMs: waitMs, probeMs: waitMs,
          grewSinceSeed: _grokWroteEvents, grewSinceLastCheck,
          extensionCount: _probeRound, maxExtensions: RESUME_MAX_EXT,
        });
        if (verdict === 'ok') { return; } // grok is answering — resume works; let the turn run
        if (verdict === 'extend') {
          // Loaded + actively writing NEW events but not answering yet (large session /
          // serialized index / a tool call before first text) → NOT the hang. Grant one
          // more EXPONENTIALLY longer window rather than killing a healthy-but-slow resume.
          // Bounded by RESUME_MAX_EXT and always well under the watchdog.
          _probeRound += 1;
          const next = extIntervalMs(_probeRound);
          log(`Grok: --resume still loading after ${Math.round(_probeWaitedMs / 1000)}s (round ${_probeRound}/${RESUME_MAX_EXT}, grok is writing session events) — waiting up to ~${Math.round(next / 1000)}s more`);
          armProbe(next);
          return;
        }
        // The hang (verdict 'fallback'): this window produced NO new events and NO
        // first_token (or extensions are exhausted). Kill grok and relaunch THIS turn
        // stateless. Mark abandoned FIRST so this child's `close` skips the exit file /
        // busy clear — the stateless relaunch owns the turn now. NOTE: onResumeHang only
        // counts a TRANSIENT failure (bounded counter); it does NOT permanently disable
        // resume — the next turn re-attempts `--resume`.
        _resumeAbandoned = true;
        const how = opts.continueSession ? '--continue' : '--resume';
        const diag = grokFailDiag();
        if (diag) { log(`Grok: ${how} failed — grok said: "${diag}"`); }
        log(`Grok: headless ${how} produced no output in ${Math.round(_probeWaitedMs / 1000)}s (${_probeRound} extension${_probeRound === 1 ? '' : 's'}) — stateless for this turn only (stored session id kept; resume retried next turn)`);
        if (grokFilePoll) { clearInterval(grokFilePoll); }
        if (watchdog) { clearTimeout(watchdog); }
        killed = true; // suppress the watchdog's own kill/report
        if (child.pid) { killProcessTree(child.pid); }
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        try { opts.onResumeHang!(); } catch (e) { log(`Grok: stateless relaunch failed: ${(e as Error)?.message ?? String(e)}`); }
      }, waitMs);
      resumeProbeTimer.unref?.();
    };
    armProbe(RESUME_PROBE_MS);
  }

  rl.on('line', (line: string) => {
    if (!line.trim()) { return; }
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      try { fs.appendFileSync(stdoutFile, line + '\n', 'utf8'); } catch { /* ignore */ }
      return;
    }
    const type: string = msg.type ?? '';
    if (type === 'assistant' || type === 'text') {
      const text: string = msg.content ?? msg.data ?? msg.text ?? msg.message ?? '';
      if (text) {
        try { fs.appendFileSync(stdoutFile, text, 'utf8'); } catch { /* ignore */ }
        emitOutputLines(text);
        _activityBuf += text;
        scheduleActivity();
      }
    } else if (type === 'error') {
      const errMsg: string = msg.message ?? JSON.stringify(msg);
      _lastGrokErr = errMsg;                 // authoritative diagnostic for a fast resume/continue failure
      log(`Grok error: ${errMsg}`);
      try { fs.appendFileSync(stdoutFile, `\n[Grok error: ${errMsg}]\n`, 'utf8'); } catch { /* ignore */ }
    } else if (type === 'end') {
      _endSeen = true;
      flushOutputLine();
      flushActivity();
      _emitGrokHook(root, 'Stop', {});
      _emitGrokHook(root, 'SessionEnd', { reason: 'completed' });
    }
  });

  const errRl = child.stderr ? readline.createInterface({ input: child.stderr }) : null;
  errRl?.on('line', (line: string) => {
    const text = line.trim();
    if (!text) { return; }
    _lastGrokStderr = text;                  // fallback diagnostic for a fast resume/continue failure
    log(`Grok stderr: ${text}`);
    if (GROK_MAX_TOOL_ERRORS > 0 && text.includes('tool_output_error')) {
      toolErrorCount++;
      if (toolErrorCount >= GROK_MAX_TOOL_ERRORS) {
        killGrok(`${toolErrorCount} tool-output errors (stuck retry loop)`);
      }
    }
  });

  child.on('close', (code: number | null) => {
    if (watchdog) { clearTimeout(watchdog); }
    if (grokFilePoll) { clearInterval(grokFilePoll); }
    if (resumeProbeTimer) { clearTimeout(resumeProbeTimer); resumeProbeTimer = null; }
    if (_resumeAbandoned) {
      // The resume hang-probe killed this grok and a fresh stateless run has
      // already taken over THIS turn (it re-set _activeChildren/_busyRoots and owns
      // the exit file). Do NOT write the exit file, clear busy state, or delete the
      // active child here — that would clobber the relaunch. Just release our own
      // stream handles and bow out.
      errRl?.close();
      rl.close();
      return;
    }
    try { pumpGrokSessionFiles(); } catch { /* best-effort final drain of trailing records */ }
    flushOutputLine();
    flushActivity();
    errRl?.close();
    rl.close();
    _activeChildren.delete(root);
    _busyRoots.delete(root);
    // A session-log turn_ended already reported the true outcome via _forcedExit;
    // don't let the SIGKILL exit code (1) override a clean finish.
    const exitCode = _forcedExit ?? code ?? 1;
    // AUTH failure short-circuit for a fast non-zero exit that bypassed
    // finishFromTurnEnd (grok printed "Not signed in … grok login --device-code"
    // to stderr / an error record and quit — the live grok-token-expiry bug). Never
    // retryable: emit reauth_required (and the stdout sentinel for the loop's
    // AuthDetector) and set _endSeen so the retryable StopFailure below is skipped.
    const _closeAuthDiag = grokFailDiag();
    if (exitCode !== 0 && !_grokReauthEmitted && isGrokAuthFailure(_closeAuthDiag)) {
      _grokReauthEmitted = true;
      _endSeen = true;
      _emitGrokReauthHook(root, stdoutFile, log, `headless exit ${exitCode} (not signed in)`, opts.providerId ?? 'grok-tui', _closeAuthDiag);
    }
    // A resume/continue that FAILED FAST by exiting non-zero directly (grok printed to
    // stderr and quit, e.g. "Session <id> not found locally … 404 Not Found") never
    // wrote a session-log turn_ended, so it bypassed finishFromTurnEnd's diagnostic.
    // Surface grok's captured reason here too so this failure shape is not a blind guess.
    if (exitCode !== 0 && !_sawFirstToken && (opts.sessionId || opts.continueSession)) {
      const how = opts.continueSession ? '--continue' : '--resume';
      const diag = grokFailDiag();
      if (diag) { log(`Grok: ${how} failed fast (exit ${exitCode}) — grok said: "${diag}"`); }
    }
    log(`Grok: exited (code=${exitCode})`);
    if (!_endSeen) {
      _emitGrokHook(root, exitCode === 0 ? 'Stop' : 'StopFailure', { exit_code: exitCode });
      _emitGrokHook(root, 'SessionEnd', { reason: exitCode === 0 ? 'completed' : 'error' });
    }
    try { fs.writeFileSync(exitFile, `${exitCode}\n`, 'utf8'); } catch { /* ignore */ }
  });
}

/**
 * grok-cli: PERSISTENT — a fresh HEADLESS grok process every turn, but launched
 * with `--resume <id>` (or a bootstrapping `--session-id`) so grok's own workspace
 * session — and thus conversation context — carries across turns (user-requested;
 * grok-cli used to be stateless). Uses the exact same persistent-headless path and
 * first_token hang-probe as headless grok-tui, so a hung `grok --resume` falls back
 * to a stateless relaunch instead of hanging the loop.
 */
export function sendGrokCliPrompt(
  root: string,
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  showOutput?: () => void,
): void {
  if (grokAcpEnabled()) {
    sendGrokAcpPrompt(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, 'grok-cli', model, showOutput);
    return;
  }
  sendGrokPersistentHeadless(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, 'grok-cli', model, showOutput);
}

// ---------------------------------------------------------------------------
// PERSISTENT-PROCESS (ACP) path — one long-lived `grok agent stdio` per root.
// ---------------------------------------------------------------------------

/** Redaction-aware AcpHostHooks that append to this root's hook feed. Shared by
 *  the non-leader and leader ACP paths so hook emission stays in one place. */
function makeAcpHooks(root: string, log: (msg: string) => void): AcpHostHooks {
  return {
    emitHook: (name, extra) => {
      if (name === 'Notification' && typeof extra['message'] === 'string') {
        const msg = redactSecrets(String(extra['message'])).slice(0, 1200);
        if (!msg.trim()) { return; }
        _emitGrokHook(root, 'Notification', { ...extra, message: msg });
      } else {
        _emitGrokHook(root, name, redactDeep(extra));
      }
    },
    log,
  };
}

/** Get (or lazily create) the NON-LEADER persistent ACP session for a root. */
function getOrCreateAcpSession(
  root: string, providerId: 'grok-cli' | 'grok-tui', model: string | undefined, log: (msg: string) => void,
  resolvedSessionId: string | undefined,
): GrokAcpSession {
  let sess = _acpSessions.get(root);
  if (sess) { return sess; }
  // Resume-on-(re)start: seed the id to session/load from the persisted id, else
  // the newest grok session on disk for this cwd (works whether that session was
  // created by a prior ACP run or the legacy headless `--continue`).
  // Layer A.2: PREFER the persisted id (session-state.json) over the disk-latest
  // fallback — disk-latest can resume the WRONG session (a stray/newer dir). Use
  // disk-latest ONLY when there is no persisted id.
  const seedId = getSessionId(root, providerId) || resolvedSessionId || getGrokLatestSessionId(root) || undefined;
  sess = new GrokAcpSession({ root, model, bin: GROK_BIN, hooks: makeAcpHooks(root, log), initialSessionId: seedId });
  _acpSessions.set(root, sess);
  return sess;
}

/**
 * LEADER-AWARE ensure (Layer B, 1.4.193). When AUTODEV_GROK_LEADER is ON, ensure a
 * per-agent leader + keepalive backend (orphan-sweeping/adopting/spawning as
 * needed) and return a LEADER-CLIENT ACP session that ATTACHES to the warm session
 * WITHOUT session/load. When the flag is OFF — or the leader backend can't be
 * established — this returns the existing non-leader session UNCHANGED. Async
 * because ensuring the leader spawns detached processes on a cold start.
 */
async function ensureAcpSession(
  root: string, providerId: 'grok-cli' | 'grok-tui', model: string | undefined, log: (msg: string) => void,
  resolvedSessionId: string | undefined,
): Promise<GrokAcpSession> {
  if (leaderModeEnabled() && !_leaderUnavailable.has(root)) {
    const cached = _acpSessions.get(root);
    if (cached && cached.isAlive()) { return cached; }
    if (cached) { try { cached.close(); } catch { /* ignore */ } _acpSessions.delete(root); }
    const info = await ensureLeader({ root, bin: GROK_BIN, providerId, model, log });
    if (info) {
      const sess = new GrokAcpSession({
        root, model, bin: GROK_BIN, hooks: makeAcpHooks(root, log),
        initialSessionId: info.sessionId, leaderSocket: info.socket, attachWithoutLoad: true,
      });
      _acpSessions.set(root, sess);
      return sess;
    }
    // Leader couldn't be established (see the detailed ensureLeader failure log
    // above). CACHE that for this run so we DON'T thrash a leader spawn every turn,
    // then fall through — ONCE, quietly — to the non-leader ACP path, which still
    // resumes context via a quiet session/load. On Windows this is the expected
    // steady state until grok exposes a cross-platform leader transport.
    _leaderUnavailable.add(root);
    log('grok leader: backend unavailable — using the non-leader ACP path for the rest of this run (will not retry the leader; set AUTODEV_GROK_LEADER_SOCKET_MS to extend the socket wait)');
  }
  return getOrCreateAcpSession(root, providerId, model, log, resolvedSessionId);
}

/**
 * Leader POISON-ESCAPE: the attached session id was rejected by the leader
 * ("unknown session id" — the keepalive died / a wrong id). Reap the leader
 * backend, clear the persisted id, drop the thin client — the caller then
 * re-ensures a FRESH leader with session/new.
 */
function recoverLeaderPoison(root: string, providerId: 'grok-cli' | 'grok-tui', log: (msg: string) => void): void {
  try { stopLeader(root, log); } catch { /* ignore */ }
  try { clearSessionId(root, providerId); } catch { /* ignore */ }
  _leaderUnavailable.delete(root); // a deliberate reap → allow one fresh leader spawn
  const s = _acpSessions.get(root);
  if (s) {
    if (s.pid) { try { killProcessTree(s.pid); } catch { /* ignore */ } }
    try { s.close(); } catch { /* ignore */ }
    _acpSessions.delete(root);
  }
}

/**
 * Fire-and-forget: run ONE turn through the persistent ACP session. Streams
 * assistant text to stdoutFile and writes the exit code to exitFile exactly once
 * at turn end — preserving the taskLoop contract byte-for-byte. The grok process
 * STAYS ALIVE between turns; a crash/exit is detected and the NEXT turn respawns
 * + session/load restores context. If the ACP handshake can't be established
 * (older grok, or a transient spawn failure) it transparently FALLS BACK to the
 * legacy one-shot headless path so nothing regresses.
 */
export function sendGrokAcpPrompt(
  root: string,
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  providerId: 'grok-cli' | 'grok-tui',
  model?: string,
  showOutput?: () => void,
): void {
  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile, '', 'utf8'); } catch { /* ignore */ }
  let promptText = '';
  try { promptText = fs.readFileSync(promptFilePath, 'utf8'); }
  catch (err) {
    try { fs.appendFileSync(stdoutFile, `\n[Grok ACP: cannot read prompt file: ${(err as Error)?.message ?? err}]\n`, 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
    return;
  }
  _busyRoots.add(root);
  if (showOutput) { try { showOutput(); } catch { /* ignore */ } }
  const sink = (text: string): void => { try { fs.appendFileSync(stdoutFile, text, 'utf8'); } catch { /* ignore */ } };
  void (async () => {
    let sess: GrokAcpSession;
    try {
      sess = await ensureAcpSession(root, providerId, model, log, resolvedSessionId);
      await sess.ensureReady();
    } catch (err) {
      const cur = _acpSessions.get(root);
      const stderr = cur?.stderrSnapshot ?? '';
      const startupErr = `${(err as Error)?.message ?? err} ${stderr}`;
      log(`Grok ACP: startup failed (${(err as Error)?.message ?? err}); stderr="${stderr.slice(0, 200)}" — falling back to headless one-shot`);
      if (cur) { try { cur.close(); } catch { /* ignore */ } }
      _acpSessions.delete(root);
      _busyRoots.delete(root);
      // AUTH failure at ACP startup (grok not signed in): the headless fallback
      // would just re-hit the same logged-out gate, so short-circuit to
      // reauth_required (non-retryable) instead of falling through.
      if (isGrokAuthFailure(startupErr)) {
        _emitGrokReauthHook(root, stdoutFile, log, 'ACP startup (not signed in)', providerId, stderr.slice(0, 160));
        try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
        return;
      }
      // ACP unavailable / handshake failed → clean fallback to the one-shot path
      // (which writes its own stdout/exit + hooks). Nothing regresses.
      sendGrokPersistentHeadless(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, providerId, model, showOutput);
      return;
    }
    // Persist the session id so a restart can session/load it (resume-on-restart).
    if (sess.sessionId) { try { saveSessionId(root, providerId, sess.sessionId); } catch { /* ignore */ } }
    const runTurnSafe = async (s: GrokAcpSession): Promise<{ clean: boolean; stopReason: string; error?: string }> => {
      try { return await s.runTurn(promptText, sink); }
      catch (err) { return { clean: false, stopReason: 'exception', error: (err as Error)?.message ?? String(err) }; }
    };
    let res = await runTurnSafe(sess);
    // Leader POISON-ESCAPE: the warm session was rejected (keepalive died / stale
    // id). Reap the leader + session/new on a FRESH leader, then retry ONCE.
    if (leaderModeEnabled() && sess.attachMode && !res.clean && AcpSession.isUnknownSessionError(res.error)) {
      log('Grok leader: attach rejected (poison) — reaping leader, starting a fresh session, retrying once');
      recoverLeaderPoison(root, providerId, log);
      try {
        sess = await ensureAcpSession(root, providerId, model, log, undefined);
        await sess.ensureReady();
        if (sess.sessionId) { try { saveSessionId(root, providerId, sess.sessionId); } catch { /* ignore */ } }
        res = await runTurnSafe(sess);
      } catch (err) { res = { clean: false, stopReason: 'poison-recover-failed', error: (err as Error)?.message ?? String(err) }; }
    }
    if (!res.clean && res.error) {
      try { fs.appendFileSync(stdoutFile, `\n[Grok ACP: turn ended ${res.stopReason} — ${res.error}]\n`, 'utf8'); } catch { /* ignore */ }
      // AUTH failure mid-turn (token expired between turns): surface reauth_required
      // so the loop pauses into 🔑 needs-auth instead of retrying a login it can't
      // satisfy. The stdout line above also feeds the loop's AuthDetector.
      if (isGrokAuthFailure(res.error)) {
        _emitGrokReauthHook(root, stdoutFile, log, `ACP turn ${res.stopReason} (not signed in)`, providerId, res.error);
      }
    }
    try { fs.writeFileSync(exitFile, `${res.clean ? 0 : 1}\n`, 'utf8'); } catch { /* ignore */ }
    _busyRoots.delete(root);
  })();
}

/**
 * Deliver a mid-run steer to the LIVE persistent grok process (a queued
 * session/prompt). Returns true only when a live ACP session accepted it; false
 * lets the caller fall back to the durable TODO buffer (at-least-once).
 */
export function steerGrokAcp(root: string, text: string, log: (msg: string) => void): boolean {
  const sess = _acpSessions.get(root);
  if (!sess || !sess.isAlive()) { return false; }
  const ok = sess.steer(text);
  if (ok) { log(`Grok ACP: steered live process (${text.length} chars) — queued to the running session`); }
  return ok;
}

/** True if a persistent ACP session for this root is mid-turn. */
export function isGrokAcpBusy(root: string): boolean {
  const sess = _acpSessions.get(root);
  return !!sess && sess.isBusy();
}

/** True when a LIVE (alive) persistent grok ACP session is held for this root. */
export function hasGrokAcpSession(root: string): boolean {
  const sess = _acpSessions.get(root);
  return !!sess && sess.isAlive();
}

/**
 * Durable-steer delivery to an EXISTING live grok ACP session. Returns a promise
 * that resolves when the steered turn COMPLETES (so the caller can ack + de-queue
 * only then), or null when no live session exists (the caller keeps it queued and
 * retries via {@link ensureGrokAcpSteer} at the next boundary).
 */
export function steerGrokAcpTracked(root: string, text: string, log: (msg: string) => void): Promise<import('./GrokAcpSession').AcpTurnResult> | null {
  const sess = _acpSessions.get(root);
  if (!sess || !sess.isAlive()) { return null; }
  const p = sess.steerTracked(text);
  if (p) { log(`Grok ACP: durable steer delivered to live session (${text.length} chars) — awaiting completion`); }
  return p;
}

/**
 * Restart-drain delivery: ENSURE a live grok ACP session (spawn + session/load if
 * none is held — e.g. right after a loop restart with an empty TODO), then deliver
 * the steer and await its completion. Returns the turn result, or null when the
 * session could not be brought up (caller keeps the steer queued for a later
 * boundary). Grok stays ALIVE between turns, so the common case just reuses the
 * live session.
 */
export async function ensureGrokAcpSteer(
  root: string, providerId: 'grok-cli' | 'grok-tui', model: string | undefined, text: string, log: (msg: string) => void,
): Promise<import('./GrokAcpSession').AcpTurnResult | null> {
  if (!grokAcpEnabled()) { return null; }
  const sess = await ensureAcpSession(root, providerId, model, log, undefined);
  try { await sess.ensureReady(); }
  catch (err) { log(`Grok ACP: durable-steer ensureReady failed (${(err as Error)?.message ?? err})`); return null; }
  if (sess.sessionId) { try { saveSessionId(root, providerId, sess.sessionId); } catch { /* ignore */ } }
  const p = sess.steerTracked(text);
  if (!p) { return null; }
  log(`Grok ACP: durable steer (re)delivered on restart-drain (${text.length} chars) — awaiting completion`);
  return p;
}

/**
 * grok-tui: persistent — run the turn in the per-workspace tmux session so
 * grok's in-process context accumulates across tasks. Falls back to the old
 * headless spawn (with --resume) when tmux is unavailable so nothing regresses.
 */
/**
 * Pure decision for whether a grok turn uses the tmux persistent path, given
 * whether tmux exists and the provider id. Extracted so the routing is
 * unit-testable without spawning a process.
 *
 * - grok-tui + tmux    → useTmux: true  (persistent live pane; context accretes)
 * - grok-tui + no tmux → useTmux: false (HEADLESS path — persistence handled there
 *   via `grok --continue` behind the first_token hang-probe; see decideHeadlessGrokMode)
 * - grok-cli           → useTmux: false always (never uses tmux)
 */
export function decideGrokRunMode(
  opts: { tmuxAvailable: boolean; providerId: string },
): { useTmux: boolean } {
  return { useTmux: opts.providerId === 'grok-tui' && opts.tmuxAvailable };
}

/**
 * Pure decision for how the HEADLESS grok-tui / grok-cli path (no tmux) should
 * launch this turn. Extracted so the resume/bootstrap/stateless routing is
 * unit-testable. The `maxConsecutiveFailures` guard REPLACES the old permanent
 * "resumeBroken" flag that doomed a whole run to statelessness after one hiccup.
 *
 * - no folder session yet                                → 'new-session': there is no
 *   session on disk for this cwd to continue, so bootstrap persistence with a fresh
 *   named session (`--session-id`, mints + persists a UUID; NOT `--continue`, which
 *   would have nothing to continue), behind the probe as a safety net.
 * - a folder session exists, failures < max              → 'continue': resume the cwd's
 *   most-recent session with `grok --continue` — robust to the stale-id / cwd-tracking
 *   drift that made an explicit `--resume <id>` error in ~1s on Windows. Gated by the
 *   first_token hang-probe. This is the STEADY STATE — every turn continues.
 * - a folder session, failures >= max (sustained hang)   → 'stateless' for exactly ONE
 *   breather turn (skip the probe cost once); the caller resets the counter so the
 *   NEXT turn returns to 'continue'. The folder session is untouched, so continuity is
 *   NEVER permanently abandoned — persistence self-heals.
 *
 * NOTE: the decision keys off FOLDER-SESSION PRESENCE (newestGrokSessionDir exists),
 * NOT a stored id — because `--continue` needs no id, and keying off a stored id is
 * exactly what let a stale/mismatched id drive a doomed `--resume`.
 */
export function decideHeadlessGrokMode(
  args: { hasFolderSession: boolean; consecutiveResumeFailures: number; maxConsecutiveFailures?: number },
): 'continue' | 'new-session' | 'stateless' {
  if (!args.hasFolderSession) { return 'new-session'; }
  const max = args.maxConsecutiveFailures ?? RESUME_MAX_CONSEC_FAILURES;
  if (args.consecutiveResumeFailures >= max) { return 'stateless'; }
  return 'continue';
}

/**
 * Pure verdict for the headless resume hang-probe (multi-round exponential, 1.4.185).
 *   'ok'       — grok emitted first_token → the resumed prompt is being answered;
 *                let the persistent turn run to its normal turn-end.
 *   'extend'   — the window elapsed with NO first_token, but grok wrote NEW session
 *                events during it (`grewSinceLastCheck`) — it loaded the session and is
 *                actively working (a large/serialized session still streaming, or a tool
 *                call before the first text). NOT the hang → grant one more, EXPONENTIALLY
 *                longer window, as long as fewer than `maxExtensions` have been granted.
 *                This keeps resume patient with a slow-but-alive load (~17 agents serialize
 *                on grok's shared session index) yet bounded well under the run watchdog.
 *   'fallback' — the window elapsed with NO first_token AND no progress this window
 *                (`grewSinceLastCheck` false), OR the extension budget is exhausted → the
 *                hang; kill + relaunch stateless. Because progress is checked PER WINDOW,
 *                a dead process falls back on its first silent window (it never burns the
 *                whole multi-round budget).
 *   'wait'     — neither yet (window not elapsed and no first_token) → keep waiting.
 *
 * Progress source: `grewSinceLastCheck` (NEW events since the LAST probe check) is the
 * per-round gate; when a caller doesn't pass it we fall back to the legacy `grewSinceSeed`
 * ("ever wrote"). Extension budget: `extensionCount` / `maxExtensions`; when a caller
 * passes neither, the legacy single-shot `alreadyExtended` boolean (max = 1) is used, so
 * the pre-1.4.185 single-grace-window behavior is preserved for old callers.
 *
 * Rationale (grok 1.0.13 measured): a healthy `--resume` produces first_token in ~40ms,
 * so the time window is not a false trigger for normal sessions; the progress grace exists
 * only so a very large / contended session's slower load isn't mistaken for the
 * loaded-but-never-answers hang.
 */
export function resumeProbeVerdict(
  args: {
    sawFirstToken: boolean;
    elapsedMs: number;
    probeMs: number;
    grewSinceSeed?: boolean;        // legacy: grok wrote events at all this turn (back-compat)
    grewSinceLastCheck?: boolean;   // per-round: NEW events since the LAST probe check
    alreadyExtended?: boolean;      // legacy single-shot extension gate (back-compat)
    extensionCount?: number;        // multi-round: extensions granted so far
    maxExtensions?: number;         // multi-round: extension budget
  },
): 'ok' | 'extend' | 'fallback' | 'wait' {
  if (args.sawFirstToken) { return 'ok'; }
  if (args.probeMs > 0 && args.elapsedMs >= args.probeMs) {
    // Real progress THIS window gates the extension; prefer the per-round signal, fall
    // back to the legacy "ever wrote" grace for old callers that don't pass it.
    const progressed = args.grewSinceLastCheck ?? args.grewSinceSeed ?? false;
    if (!progressed) { return 'fallback'; }               // silent window → the hang
    const count = args.extensionCount ?? (args.alreadyExtended ? 1 : 0);
    const max = args.maxExtensions ?? 1;                  // legacy default: a single grace window
    return count < max ? 'extend' : 'fallback';
  }
  return 'wait';
}

export function sendGrokTuiPrompt(
  root: string,
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  showOutput?: () => void,
): void {
  // Preferred persistent model: ONE long-lived `grok agent stdio` (ACP). Cleaner
  // than the tmux PTY (no pane-scraping, real steering, unified with grok-cli).
  if (grokAcpEnabled()) {
    sendGrokAcpPrompt(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, 'grok-tui', model, showOutput);
    return;
  }
  const mode = decideGrokRunMode({ tmuxAvailable: tmuxAvailable(), providerId: 'grok-tui' });
  if (mode.useTmux) {
    runGrokTmuxTurn(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, model, showOutput);
    return;
  }
  // No tmux (e.g. Windows) → the persistent HEADLESS path.
  sendGrokPersistentHeadless(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, 'grok-tui', model, showOutput);
}

/**
 * The persistent HEADLESS grok launch, shared by grok-cli and headless grok-tui.
 * We want PERSISTENCE across turns, so when the cwd already has a grok session on disk
 * we resume the MOST RECENT one with `grok --continue` (robust to the stale-id /
 * cwd-tracking drift that made an explicit `--resume <id>` error in ~1s on Windows and
 * forced every turn stateless). grok's headless resume can also hang a resumed turn
 * (loaded-but-never-answers) → the watchdog, so every persistent launch is gated behind
 * a FAST first_token hang-probe: if grok begins answering within
 * AUTODEV_GROK_RESUME_PROBE_MS the turn runs normally (persistent, context intact); if
 * not, sendGrokPrompt kills it and calls onResumeHang to relaunch THIS turn stateless. A
 * failure is COUNTED (bounded, NOT a permanent poison): the folder session is preserved
 * and the NEXT turn re-attempts `--continue`, so a
 * transient hiccup can't strand the run in per-turn statelessness (the pre-1.4.184 bug).
 * Only after RESUME_MAX_CONSEC_FAILURES straight failures does a single breather turn
 * skip resume, after which resume is tried again. The stateless path stays intact as the
 * safety net (sendGrokPrompt's session-log tailing still forwards tool/narration events
 * and detects turn_ended either way).
 */
function sendGrokPersistentHeadless(
  root: string,
  promptFilePath: string,
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  providerId: 'grok-cli' | 'grok-tui',
  model?: string,
  showOutput?: () => void,
): void {
  const label = providerId === 'grok-cli' ? 'Grok CLI' : 'Grok TUI';
  const PROBE_MS = envNum('AUTODEV_GROK_RESUME_PROBE_MS', 90_000);
  // Continuity is decided by whether grok has a session on disk for THIS cwd — the same
  // signal `grok --continue` itself uses — NOT a stored id (a stale/mismatched id was the
  // root cause of the instant `--resume <id>` error). resolvedSessionId/getSessionId are
  // kept only for logging + best-effort id display.
  const hasFolderSession = !!newestGrokSessionDir(path.resolve(root));
  const persistedSid = resolvedSessionId || getSessionId(root, providerId);
  // Stateless relaunch: grok mints a throwaway id for THIS turn. persist:false means
  // it never overwrites the STORED session id in session-state.json → the next turn
  // still resumes the real conversation. This is the per-turn safety net, NOT the
  // steady state (the steady state is 'resume').
  const runStateless = (): void => {
    sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
      model, showOutput, persist: false, providerId,
    });
  };
  // The fallback the probe / error-before-first-token path invokes: count ONE
  // transient resume failure (bounded — NOT a permanent poison) and relaunch this
  // same turn stateless so the task completes. The stored id is untouched, so the
  // next turn re-attempts `--resume <storedId>`.
  const onResumeHang = (): void => {
    _noteResumeFailure(root);
    runStateless();
  };
  // Clear the failure counter the instant a resumed turn starts answering.
  const onResumeOk = (): void => { _noteResumeSuccess(root); };

  const decision = decideHeadlessGrokMode({
    hasFolderSession, consecutiveResumeFailures: _resumeFailCount(root),
  });

  if (decision === 'stateless') {
    // Sustained continue failures → ONE breather turn (skip the probe cost), then the
    // counter resets so the NEXT turn continues again. Persistence is never abandoned.
    log(`${label}: --continue failed ${_resumeFailCount(root)}× in a row — one stateless breather turn, will retry --continue next turn`);
    _noteResumeSuccess(root); // reset so the next turn returns to 'continue'
    runStateless();
    return;
  }
  if (decision === 'continue') {
    const idNote = persistedSid ? ` (${persistedSid.slice(0, 8)}…)` : '';
    log(`${label}: continuing most-recent session for cwd${idNote} (headless --continue)`);
    sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
      model, showOutput, persist: true, continueSession: true, providerId,
      resumeProbeMs: PROBE_MS, onResumeHang, onResumeOk,
    });
    return;
  }
  // new-session — no folder session yet: bootstrap a fresh named session so later turns
  // have one to `--continue`. A fresh `--session-id` isn't a resume, but keep the probe
  // as a belt-and-braces safety net (and it can never exceed the watchdog).
  log(`${label}: starting a new persistent session (headless)`);
  sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
    model, showOutput, persist: true, providerId,
    resumeProbeMs: PROBE_MS, onResumeHang,
  });
}

// ---------------------------------------------------------------------------
// steerGrokTui — inject a message into the RUNNING grok turn via the live pane.
//
// Because the tmux session is a real TTY, keys sent to a mid-turn pane are
// delivered to grok's input and folded into the current turn (confirmed with a
// live REPL stand-in). Mirrors steerClaudeTui: only injects when a turn is
// actually running; returns false when there is no live pane so the caller
// keeps the durable TODO fallback (at-least-once delivery).
// ---------------------------------------------------------------------------
export async function steerGrokTui(root: string, text: string, log: (msg: string) => void): Promise<boolean> {
  const sess = _tmuxSessions.get(root);
  if (!sess) { return false; }            // no live tmux session (headless / not started)
  if (!_busyRoots.has(root)) { return false; } // only steer a turn in flight
  if (!hasSession(sess.name)) { _tmuxSessions.delete(root); return false; }
  try {
    // Literal keystrokes (send-keys -l), NOT a bracketed paste — grok's TUI
    // misreads a paste as a directory picker. Flatten to one line (no reliable
    // newline-without-submit key), then Enter to inject into the running turn.
    const flat = text.replace(/\r?\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
    for (let i = 0; i < flat.length; i += 3000) {
      if (tmux(['send-keys', '-t', sess.name, '-l', flat.slice(i, i + 3000)]) === null) { return false; }
    }
    if (tmux(['send-keys', '-t', sess.name, 'Enter']) === null) { return false; }
    log(`Grok TUI: steered live pane (${text.length} chars) — injected into current turn`);
    return true;
  } catch (err) {
    log(`Grok TUI: steer failed: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Called by taskLoop reset interval / provider close. Kills any live grok for
 * this root — the tmux session AND any headless child — while PRESERVING the
 * persisted session id so a later task relaunches with --resume (context intact).
 */
export function closeGrokTuiSession(root: string, _log: (msg: string) => void): void {
  const acp = _acpSessions.get(root);
  if (acp) {
    // Reap grok's whole worker subtree (grok forks a per-turn worker child), then
    // close — SIGKILL of just the parent would orphan the worker to init.
    // LEADER-AWARE (Layer B): acp.pid here is the THIN CLIENT. The leader + keepalive
    // are DETACHED (their own process groups, not in the client's tree), so this
    // reaps ONLY the client — the leader survives the loop restart, exactly as
    // intended. The app reaps the leader itself via `autodev leader-stop <root>`.
    if (acp.pid) { try { killProcessTree(acp.pid); } catch { /* ignore */ } }
    try { acp.close(); } catch { /* ignore */ }
    _acpSessions.delete(root);
  }
  const child = _activeChildren.get(root);
  if (child) {
    if (child.pid) { killProcessTree(child.pid); }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    _activeChildren.delete(root);
  }
  const sess = _tmuxSessions.get(root);
  if (sess) { killSession(sess.name); _tmuxSessions.delete(root); }
  else {
    // No cached handle but a session may still exist under the deterministic name.
    const name = sessionName(root);
    if (hasSession(name)) { killSession(name); }
  }
  _busyRoots.delete(root);
  _emittedToolIds.delete(root);
  // A close marks a run boundary — clear the transient resume-failure count so the
  // next loop/run starts clean and re-attempts persistent --resume immediately.
  _resumeFailures.delete(root);
}

/** Kill all live grok sessions — called on SDK/extension shutdown. */
export function closeAllGrokTuiSessions(): void {
  for (const acp of _acpSessions.values()) {
    if (acp.pid) { try { killProcessTree(acp.pid); } catch { /* ignore */ } }
    try { acp.close(); } catch { /* ignore */ }
  }
  _acpSessions.clear();
  for (const child of _activeChildren.values()) {
    if (child.pid) { killProcessTree(child.pid); }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  _activeChildren.clear();
  for (const sess of _tmuxSessions.values()) {
    killSession(sess.name);
  }
  _tmuxSessions.clear();
  _busyRoots.clear();
  _emittedToolIds.clear();
  _resumeFailures.clear();
}

// ---------------------------------------------------------------------------
// detectGrokTuiRateLimit
// ---------------------------------------------------------------------------
export function detectGrokTuiRateLimit(stdoutContent: string): ReturnType<typeof RateLimitDetector.detect> {
  return RateLimitDetector.detect(stdoutContent);
}