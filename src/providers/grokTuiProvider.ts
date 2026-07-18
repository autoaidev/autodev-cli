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
import { eventTypeFor } from '../hookEventNormalizer';
import { RateLimitDetector } from '../rateLimit';
import { saveSessionId, getSessionId } from '../sessionState';
import type { ProviderId } from '../providers';

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

/** Live tmux-backed grok sessions by root (persistent grok-tui). */
interface TmuxSession {
  name: string;       // tmux session name (deterministic from root)
  rawLog: string;     // pipe-pane capture file (append-only, ANSI-laden)
  sessionId: string;  // grok session UUID (persisted to session-state.json)
  readOffset: number; // bytes of rawLog already streamed to a stdoutFile
}
const _tmuxSessions = new Map<string, TmuxSession>();

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
 * Markers that mean grok hit the OAuth/expired-token gate instead of a prompt.
 * The loop must treat this as reauth, NOT a hung turn.
 */
const REAUTH_MARKERS = /waiting for approval|approve in your browser|sign(?:ing)? in to grok|finish signing in|device code|please (?:log ?in|sign ?in)/i;

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
function launchSession(root: string, sessionId: string, resume: boolean, model: string | undefined, log: (m: string) => void): TmuxSession {
  const name = sessionName(root);
  // A stale/dead session for this name must be cleared first.
  if (hasSession(name)) { killSession(name); }

  // Kill the one-time project-directory picker before it can block the turn.
  ensureGrokPickerDisabled(log);

  const dir = path.join(root, '.autodev', 'grok-tui');
  try { if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); } } catch { /* ignore */ }
  const rawLog = path.join(dir, 'pane.raw');
  // Start each launch with a fresh raw log so readOffset math is simple.
  try { fs.writeFileSync(rawLog, '', 'utf8'); } catch { /* ignore */ }

  // Fixed geometry so wrapping/relayout never shifts detection rows; manual
  // window-size so a human attaching can't reflow the pane mid-turn.
  tmux(['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', root]);
  tmux(['set-option', '-t', name, 'window-size', 'manual']);

  // pipe-pane BEFORE launching grok — it only captures bytes emitted after it
  // attaches (confirmed). Append mode.
  tmux(['pipe-pane', '-o', '-t', name, `cat >> ${shq(rawLog)}`]);

  // Build the interactive grok command. `exec` replaces the shell so a dead grok
  // collapses the pane/session → cheap liveness signal via has-session.
  const parts = [
    'exec', shq(GROK_BIN),
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
  tmux(['send-keys', '-t', name, parts.join(' '), 'Enter']);

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

/** Compact one-line marker for a grok tool call (for the live activity feed). */
function formatToolCall(tc: { name?: string; arguments?: string }): string {
  const name = tc?.name || 'tool';
  let arg = '';
  try {
    const a = JSON.parse(tc?.arguments || '{}') as Record<string, unknown>;
    const cand = a.target_file ?? a.file_path ?? a.path ?? a.command ?? a.query ?? a.message ?? a.to ?? '';
    if (typeof cand === 'string') { arg = cand; }
  } catch { /* non-JSON args — just show the name */ }
  arg = arg.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `» ${name}${arg ? ` ${arg}` : ''}`;
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
    for (const tc of o.tool_calls || []) { out += formatToolCall(tc) + '\n'; }
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
  const STARTUP_MS    = envNum('AUTODEV_GROK_TUI_STARTUP_MS', 8_000);
  const NOOUTPUT_MS   = envNum('AUTODEV_GROK_TUI_NOOUTPUT_MS', 25_000);
  const MAX_RUN_MS    = envNum('AUTODEV_GROK_MAX_RUN_MS', 10 * 60_000);
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

  void (async () => {
    let sess: TmuxSession;
    let justLaunched: boolean;
    try {
      const r = ensureSession(root, resolvedSessionId, model, log);
      sess = r.sess; justLaunched = r.justLaunched;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log(`Grok TUI: session launch failed: ${msg}`);
      try { fs.appendFileSync(stdoutFile, `\n[Grok TUI launch error: ${msg}]\n`, 'utf8'); } catch { /* ignore */ }
      finish(1, 'launch-failed');
      return;
    }

    // Stream only THIS turn's output: start reading at the current rawLog size.
    let readOffset = (() => { try { return fs.statSync(sess.rawLog).size; } catch { return 0; } })();

    if (justLaunched) {
      _emitGrokHook(root, 'SessionStart', { source: 'startup' });
      // Startup grace — grok's splash takes a few seconds before it accepts input.
      // Scan for the reauth gate while we wait; bail early if the token is dead.
      const deadline = Date.now() + STARTUP_MS;
      while (Date.now() < deadline) {
        await sleep(500);
        if (!hasSession(sess.name)) {
          log('Grok TUI: session died during startup');
          try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: session exited during startup]\n`, 'utf8'); } catch { /* ignore */ }
          finish(1, 'startup-exit');
          return;
        }
        const snap = capturePane(sess.name);
        if (REAUTH_MARKERS.test(snap)) {
          log('Grok TUI: reauth required (OAuth gate at startup)');
          try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: reauthentication required — please login]\n`, 'utf8'); } catch { /* ignore */ }
          finish(1, 'reauth_required');
          return;
        }
      }
      // CALIBRATED: a NEW grok session opens on a picker sitting over the input
      // box — either the welcome menu (New worktree / Resume session / Changelog /
      // Quit) or the project chooser ("Run Grok Build in a project directory?"
      // with radio options, the current dir highlighted). A RESUMED session skips
      // it. Pressing Enter confirms the highlighted default (current dir / first
      // item) and proceeds to the ready "❯" prompt. A single fixed Enter races the
      // picker's render (grok's splash can outlast the grace), so poll and press
      // Enter each time a picker is still showing, until the prompt is clear.
      const PICKER_MARKERS = /project directory|New worktree|Resume session|Changelog|\(current\)|Run Grok Build|[◯○◉●]|Select|↑\/↓/i;
      for (let i = 0; i < 8; i++) {
        if (!hasSession(sess.name)) {
          log('Grok TUI: session died during startup');
          try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: session exited during startup]\n`, 'utf8'); } catch { /* ignore */ }
          finish(1, 'startup-exit');
          return;
        }
        const snap = capturePane(sess.name);
        if (REAUTH_MARKERS.test(snap)) {
          log('Grok TUI: reauth required (OAuth gate at startup)');
          try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: reauthentication required — please login]\n`, 'utf8'); } catch { /* ignore */ }
          finish(1, 'reauth_required');
          return;
        }
        if (!PICKER_MARKERS.test(snap)) { break; } // at the ready prompt
        tmux(['send-keys', '-t', sess.name, 'Enter']);
        await sleep(1500);
      }
      // re-read the offset after startup so the splash/menu text isn't streamed
      // as "turn output".
      readOffset = (() => { try { return fs.statSync(sess.rawLog).size; } catch { return readOffset; } })();
    } else {
      _emitGrokHook(root, 'SessionStart', { source: 'resume' });
    }

    // Clean-output source: grok's structured transcript. Seed the offset at the
    // current size so we emit only THIS turn's assistant records, not the
    // resumed history. (File may not exist yet on a fresh session → offset 0.)
    const chatPath = chatHistoryPath(root, sess.sessionId);
    let chatOffset = (() => { try { return fs.statSync(chatPath).size; } catch { return 0; } })();
    let chatEmitted = false;

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
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: session exited]\n`, 'utf8'); } catch { /* ignore */ }
        _tmuxSessions.delete(root);
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

      // 2) Snapshot for detection (also catches a mid-turn reauth prompt).
      const snap = capturePane(sess.name);
      if (REAUTH_MARKERS.test(snap)) {
        try { fs.appendFileSync(stdoutFile, `\n[Grok TUI: reauthentication required — please login]\n`, 'utf8'); } catch { /* ignore */ }
        finish(1, 'reauth_required');
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
      if (snap === lastSnap) { stable++; } else { stable = 0; lastSnap = snap; }
      const running = RUNNING_INDICATOR.test(snap);
      const quietMs = Date.now() - lastGrowthMs;
      const readyToJudge = sawOutput || (Date.now() - turnStart >= NOOUTPUT_MS);
      const doneFast = sawDoneMarker && quietMs >= DEBOUNCE_MS;
      const doneSlow = readyToJudge && quietMs >= QUIET_FALLBACK_MS && stable >= STABLE_POLLS;
      if (!running && (doneFast || doneSlow)) {
        // Final drain of the transcript to catch records written between the last
        // poll and turn-end.
        const tail = drainChatHistory(chatPath, chatOffset);
        if (tail.text) {
          chatOffset = tail.offset; chatEmitted = true;
          try { fs.appendFileSync(stdoutFile, tail.text, 'utf8'); } catch { /* ignore */ }
          emitLines(tail.text);
        }
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
  providerId?: ProviderId;
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
  if (opts.persist) {
    const providerId = opts.providerId ?? 'grok-tui';
    if (opts.sessionId) {
      sessionArgs.push('--resume', opts.sessionId);
      log(`Grok: resuming session ${opts.sessionId.slice(0, 8)}… (model=${modelLabel})`);
    } else {
      const sid = randomUUID();
      sessionArgs.push('--session-id', sid);
      try { saveSessionId(root, providerId, sid); } catch { /* best effort */ }
      log(`Grok: new persistent session ${sid.slice(0, 8)}… (model=${modelLabel})`);
    }
  } else {
    log(`Grok: spawning (model=${modelLabel})`);
  }

  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  const prior = _activeChildren.get(root);
  if (prior) { try { prior.kill('SIGKILL'); } catch { /* ignore */ } _activeChildren.delete(root); }

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
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
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

  const GROK_MAX_RUN_MS      = envNum('AUTODEV_GROK_MAX_RUN_MS', 10 * 60_000);
  const GROK_MAX_TOOL_ERRORS = envNum('AUTODEV_GROK_MAX_TOOL_ERRORS', 25);
  let toolErrorCount = 0;
  let killed = false;
  const killGrok = (why: string): void => {
    if (killed) { return; }
    killed = true;
    log(`Grok watchdog: ${why} — killing run`);
    try { fs.appendFileSync(stdoutFile, `\n[Grok watchdog: ${why}]\n`, 'utf8'); } catch { /* ignore */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  };
  const watchdog = GROK_MAX_RUN_MS > 0
    ? setTimeout(() => killGrok(`exceeded ${Math.round(GROK_MAX_RUN_MS / 60_000)}min time budget`), GROK_MAX_RUN_MS)
    : null;

  const rl = readline.createInterface({ input: child.stdout! });
  let _endSeen = false;

  let _activityBuf = '';
  let _activityTimer: ReturnType<typeof setTimeout> | null = null;
  const flushActivity = (): void => {
    if (_activityTimer) { clearTimeout(_activityTimer); _activityTimer = null; }
    const t = _activityBuf.trim();
    _activityBuf = '';
    if (!t) { return; }
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
    flushOutputLine();
    flushActivity();
    errRl?.close();
    rl.close();
    _activeChildren.delete(root);
    _busyRoots.delete(root);
    const exitCode = code ?? 1;
    log(`Grok: exited (code=${exitCode})`);
    if (!_endSeen) {
      _emitGrokHook(root, exitCode === 0 ? 'Stop' : 'StopFailure', { exit_code: exitCode });
      _emitGrokHook(root, 'SessionEnd', { reason: exitCode === 0 ? 'completed' : 'error' });
    }
    try { fs.writeFileSync(exitFile, `${exitCode}\n`, 'utf8'); } catch { /* ignore */ }
  });
}

/** grok-cli: stateless — a fresh HEADLESS grok process every task. */
export function sendGrokCliPrompt(
  root: string,
  promptFilePath: string,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  showOutput?: () => void,
): void {
  sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
    model, showOutput, persist: false, providerId: 'grok-cli',
  });
}

/**
 * grok-tui: persistent — run the turn in the per-workspace tmux session so
 * grok's in-process context accumulates across tasks. Falls back to the old
 * headless spawn (with --resume) when tmux is unavailable so nothing regresses.
 */
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
  if (tmuxAvailable()) {
    runGrokTmuxTurn(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, model, showOutput);
    return;
  }
  log('Grok TUI: tmux not available — falling back to headless spawn');
  sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
    model, showOutput, persist: true, sessionId: resolvedSessionId, providerId: 'grok-tui',
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
  const child = _activeChildren.get(root);
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } _activeChildren.delete(root); }
  const sess = _tmuxSessions.get(root);
  if (sess) { killSession(sess.name); _tmuxSessions.delete(root); }
  else {
    // No cached handle but a session may still exist under the deterministic name.
    const name = sessionName(root);
    if (hasSession(name)) { killSession(name); }
  }
  _busyRoots.delete(root);
}

/** Kill all live grok sessions — called on SDK/extension shutdown. */
export function closeAllGrokTuiSessions(): void {
  for (const child of _activeChildren.values()) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  _activeChildren.clear();
  for (const sess of _tmuxSessions.values()) {
    killSession(sess.name);
  }
  _tmuxSessions.clear();
  _busyRoots.clear();
}

// ---------------------------------------------------------------------------
// detectGrokTuiRateLimit
// ---------------------------------------------------------------------------
export function detectGrokTuiRateLimit(stdoutContent: string): ReturnType<typeof RateLimitDetector.detect> {
  return RateLimitDetector.detect(stdoutContent);
}
