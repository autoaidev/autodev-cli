// ---------------------------------------------------------------------------
// grokProvider -- Grok tasks via the `grok` headless CLI. Backs BOTH provider
// variants from one shared runner:
//
//   grok-cli  (stateless):  fresh process each task, no session flags — no
//                           context accumulation across tasks.
//   grok-tui  (persistent): resumes ONE session per workspace so context
//                           carries across tasks, like an interactive session.
//                           First task: `--session-id <uuid>` (created + saved
//                           to session-state.json); later tasks: `--resume <id>`.
//
// Command:
//   grok -m <model> --always-approve --cwd <root>
//        [--session-id <uuid> | --resume <uuid>]      (grok-tui only)
//        --prompt-file <file> --output-format streaming-json
//
// streaming-json lines are parsed; assistant text chunks are appended to
// stdoutFile. exitFile is written when the process exits.
//
// Default model: sxs-claude-opus-4-6. Override via settings.grokModel.
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import * as child_process from 'child_process';
import { randomUUID } from 'crypto';
import { eventTypeFor } from '../hookEventNormalizer';
import { RateLimitDetector } from '../rateLimit';
import { saveSessionId } from '../sessionState';
import type { ProviderId } from '../providers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default model. Override via settings.grokModel. */
export const GROK_DEFAULT_MODEL = 'sxs-claude-opus-4-6';

/** Path to the grok binary — use env override for non-default installs. */
const GROK_BIN = process.env['GROK_BIN'] ?? (() => {
  // Prefer a grok on PATH; otherwise fall back to the default install location
  // (~/.grok/bin/grok) so the provider works without PATH changes.
  try {
    const home = require('os').homedir();
    const local = require('path').join(home, '.grok', 'bin', 'grok');
    if (require('fs').existsSync(local)) { return local; }
  } catch { /* ignore */ }
  return 'grok';
})();

// ---------------------------------------------------------------------------
// Per-workspace state
// ---------------------------------------------------------------------------

/** Roots with an actively-running grok turn. */
const _busyRoots = new Set<string>();

/** Active child processes by root — used to kill them on extension deactivate. */
const _activeChildren = new Map<string, child_process.ChildProcess>();

/** True while a grok turn is running for the given workspace root. */
export function isGrokTuiBusy(root: string): boolean {
  return _busyRoots.has(root);
}

/**
 * Append a REAL grok activity event to `.autodev/hooks-events.jsonl` in the
 * native Claude-Code hook schema (pixel-office reads `hook_event_name`). Grok
 * has no hooks mechanism, but its `--output-format streaming-json` stream
 * carries tool_use / tool_result events — we translate those into PreToolUse /
 * PostToolUse so pixel-office shows real per-tool activity (no synthetic
 * SessionStart/End padding beyond the genuine turn boundaries).
 */
function _emitGrokHook(root: string, hookEventName: string, extra: Record<string, unknown> = {}): void {
  try {
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    // Emit the canonical event_type too (grok writes hooks directly, bypassing
    // normalizeEvent) so pixel-office can trust it without a provider map.
    const ev = { hook_event_name: hookEventName, event_type: eventTypeFor(hookEventName), provider: 'grok-tui', cwd: root, timestamp: new Date().toISOString(), ...extra };
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// sendGrokTuiPrompt
//
// Fire-and-forget: spawns grok with --prompt-file, streams output to
// stdoutFile, writes exit code to exitFile when the process exits.
// ---------------------------------------------------------------------------
interface GrokRunOptions {
  model?: string;
  /** Reveal the output panel (VS Code shell only). */
  showOutput?: () => void;
  /** grok-tui: resume/continue a session so context accumulates across tasks. */
  persist?: boolean;
  /** Session id to resume (from resolveSession). Ignored unless `persist`. */
  sessionId?: string;
  /** Provider id used to persist a freshly-created session id. */
  providerId?: ProviderId;
}

/**
 * Shared runner behind both grok providers. `persist:false` (grok-cli) spawns
 * a stateless process; `persist:true` (grok-tui) resumes the workspace session
 * (or creates + saves a new one on the first task).
 */
export function sendGrokPrompt(
  root: string,
  /** Absolute path to the combined agent-profile + message file. */
  promptFilePath: string,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  opts: GrokRunOptions = {},
): void {
  opts.showOutput?.();

  // Only force a model when one is explicitly configured. With no model, grok
  // uses the account's own default — more robust than hardcoding a model id
  // that may not exist for every account/plan.
  const modelArgs = opts.model ? ['-m', opts.model] : [];
  const modelLabel = opts.model || 'account default';

  // Session flags — grok-tui only. Resume the stored session, or mint a new id
  // and persist it immediately so the next task resumes the same conversation.
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

  // Defensive: if a previous run for this root is somehow still tracked, kill it
  // first so `_activeChildren.set` below can't orphan it (callers gate on
  // isGrokTuiBusy, but don't rely on that alone).
  const prior = _activeChildren.get(root);
  if (prior) { try { prior.kill('SIGKILL'); } catch { /* ignore */ } _activeChildren.delete(root); }

  _busyRoots.add(root);

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
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );
    _activeChildren.set(root, child);
    _emitGrokHook(root, 'SessionStart', { source: 'startup' });
  } catch (spawnErr) {
    const msg = (spawnErr as Error)?.message ?? String(spawnErr);
    log(`Grok spawn error: ${msg}`);
    try { fs.appendFileSync(stdoutFile, `\n[Grok spawn error: ${msg}]\n`, 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
    _busyRoots.delete(root);
    return;
  }

  // -------------------------------------------------------------------------
  // Watchdog — grok can wedge internally (e.g. retrying a failing tool call
  // forever) WITHOUT ever exiting, which leaves the process alive, the exit
  // file unwritten, and the task loop blocked indefinitely on this one task
  // while new work piles up. Kill a run that overruns a hard time budget or
  // floods tool-output errors, so `close` fires, the exit file is written, and
  // the loop fails this task cleanly and moves on.
  // -------------------------------------------------------------------------
  // Env overrides: accept any finite >= 0; 0 explicitly DISABLES that guard
  // (the old `Number(x) || DEFAULT` silently reverted 0 back to the default).
  const envNum = (key: string, def: number): number => {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const GROK_MAX_RUN_MS      = envNum('AUTODEV_GROK_MAX_RUN_MS', 10 * 60_000);
  const GROK_MAX_TOOL_ERRORS = envNum('AUTODEV_GROK_MAX_TOOL_ERRORS', 25);
  let toolErrorCount = 0;
  let killed = false;
  const killGrok = (why: string): void => {
    if (killed) { return; } // never double-kill / double-log
    killed = true;
    log(`Grok watchdog: ${why} — killing run`);
    try { fs.appendFileSync(stdoutFile, `\n[Grok watchdog: ${why}]\n`, 'utf8'); } catch { /* ignore */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  };
  const watchdog = GROK_MAX_RUN_MS > 0
    ? setTimeout(() => killGrok(`exceeded ${Math.round(GROK_MAX_RUN_MS / 60_000)}min time budget`), GROK_MAX_RUN_MS)
    : null;

  // -------------------------------------------------------------------------
  // Stream stdout — each line is a streaming-json object.
  // -------------------------------------------------------------------------
  const rl = readline.createInterface({ input: child.stdout! });
  // Grok's streaming-json exposes `thought`, `text`, `end` — but NOT tool
  // events (tool use is hidden under --always-approve). So per-tool activity
  // isn't available; we surface the real turn boundaries instead: SessionStart
  // at spawn and Stop/SessionEnd on the `end` event (a genuine grok signal, not
  // synthetic padding). `_endSeen` avoids a duplicate SessionEnd on close.
  let _endSeen = false;

  // Grok exposes NO tool events in streaming-json (tool use is hidden under
  // --always-approve), so pixel-office's activity feed would otherwise be empty
  // apart from the SessionStart/End boundaries. Surface the assistant's streamed
  // TEXT as periodic, coalesced `Notification` hook events so the office shows
  // what grok is actually producing (not raw per-chunk spam).
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

  rl.on('line', (line: string) => {
    if (!line.trim()) { return; }
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      // Plain text fallback (e.g. progress lines before JSON kicks in).
      try { fs.appendFileSync(stdoutFile, line + '\n', 'utf8'); } catch { /* ignore */ }
      return;
    }

    const type: string = msg.type ?? '';

    if (type === 'assistant' || type === 'text') {
      // Assistant response text.
      const text: string = msg.content ?? msg.data ?? msg.text ?? msg.message ?? '';
      if (text) {
        try { fs.appendFileSync(stdoutFile, text, 'utf8'); } catch { /* ignore */ }
        const preview = text.replace(/\r?\n/g, ' ').trim().substring(0, 120);
        if (preview) { log(`  ${preview}`); }
        // Feed the office activity stream (coalesced).
        _activityBuf += text;
        scheduleActivity();
      }
    } else if (type === 'error') {
      const errMsg: string = msg.message ?? JSON.stringify(msg);
      log(`Grok error: ${errMsg}`);
      try { fs.appendFileSync(stdoutFile, `\n[Grok error: ${errMsg}]\n`, 'utf8'); } catch { /* ignore */ }
    } else if (type === 'end') {
      // Genuine turn-end from grok's stream → real session boundary.
      _endSeen = true;
      flushActivity();               // emit any buffered assistant text first
      _emitGrokHook(root, 'Stop', {});
      _emitGrokHook(root, 'SessionEnd', { reason: 'completed' });
    }
    // `thought` and other event types stay out of the output file.
  });

  // Read stderr LINE by line (not raw chunks) so a `tool_output_error` marker
  // split across two data chunks is still counted exactly once.
  const errRl = child.stderr ? readline.createInterface({ input: child.stderr }) : null;
  errRl?.on('line', (line: string) => {
    const text = line.trim();
    if (!text) { return; }
    log(`Grok stderr: ${text}`);
    // A flood of tool-output errors means grok is stuck retrying a tool it
    // can't complete — kill it now rather than waiting out the time budget.
    if (GROK_MAX_TOOL_ERRORS > 0 && text.includes('tool_output_error')) {
      toolErrorCount++;
      if (toolErrorCount >= GROK_MAX_TOOL_ERRORS) {
        killGrok(`${toolErrorCount} tool-output errors (stuck retry loop)`);
      }
    }
  });

  child.on('close', (code: number | null) => {
    if (watchdog) { clearTimeout(watchdog); }
    flushActivity();                 // flush any trailing assistant text
    errRl?.close();
    rl.close();
    _activeChildren.delete(root);
    _busyRoots.delete(root);
    const exitCode = code ?? 1;
    log(`Grok: exited (code=${exitCode})`);
    // Fallback SessionEnd only if grok didn't already emit an `end` event
    // (abnormal exit / killed) — avoids a duplicate from the normal path.
    if (!_endSeen) {
      _emitGrokHook(root, exitCode === 0 ? 'Stop' : 'StopFailure', { exit_code: exitCode });
      _emitGrokHook(root, 'SessionEnd', { reason: exitCode === 0 ? 'completed' : 'error' });
    }
    try { fs.writeFileSync(exitFile, `${exitCode}\n`, 'utf8'); } catch { /* ignore */ }
  });
}

/** grok-cli: stateless — a fresh grok process every task (no session flags). */
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

/** grok-tui: persistent — resume the workspace session so context accumulates. */
export function sendGrokTuiPrompt(
  root: string,
  promptFilePath: string,
  /** Session id from resolveSession (undefined on the first task). */
  resolvedSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  showOutput?: () => void,
): void {
  sendGrokPrompt(root, promptFilePath, stdoutFile, exitFile, log, {
    model, showOutput, persist: true, sessionId: resolvedSessionId, providerId: 'grok-tui',
  });
}

// ---------------------------------------------------------------------------
// closeGrokTuiSession
// Called by taskLoop reset interval. grok-tui persists its session id in
// session-state.json BY DESIGN (so context survives), so we only ensure no
// child is left running — the session id is intentionally preserved.
// ---------------------------------------------------------------------------
export function closeGrokTuiSession(root: string, _log: (msg: string) => void): void {
  // Kill any active child for this root; keep the persisted session id.
  const child = _activeChildren.get(root);
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } _activeChildren.delete(root); }
  _busyRoots.delete(root);
}

/** Kill all active grok processes — called on extension deactivate. */
export function closeAllGrokTuiSessions(): void {
  for (const child of _activeChildren.values()) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  _activeChildren.clear();
  _busyRoots.clear();
}

// ---------------------------------------------------------------------------
// detectGrokTuiRateLimit
// ---------------------------------------------------------------------------
export function detectGrokTuiRateLimit(stdoutContent: string): ReturnType<typeof RateLimitDetector.detect> {
  return RateLimitDetector.detect(stdoutContent);
}
