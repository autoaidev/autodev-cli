// ---------------------------------------------------------------------------
// grokTuiProvider -- Grok tasks via `grok --prompt-file` (simple CLI, no ACP).
//
// Each task spawns a FRESH grok process without -c, so there is no context
// accumulation across tasks (which previously caused auto-compaction /
// "Loop: stopping" issues).
//
// Command:
//   grok -m <model> --always-approve --cwd <root> --prompt-file <file>
//         --output-format streaming-json
//
// streaming-json lines are parsed; assistant text chunks are appended to
// stdoutFile.  exitFile is written when the process exits.
//
// Default model: sxs-claude-opus-4-6. Override via settings.grokModel.
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import * as child_process from 'child_process';
import { RateLimitDetector } from '../rateLimit';

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
    const ev = { hook_event_name: hookEventName, provider: 'grok-tui', cwd: root, timestamp: new Date().toISOString(), ...extra };
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// sendGrokTuiPrompt
//
// Fire-and-forget: spawns grok with --prompt-file, streams output to
// stdoutFile, writes exit code to exitFile when the process exits.
// ---------------------------------------------------------------------------
export function sendGrokTuiPrompt(
  root: string,
  /** Absolute path to the combined agent-profile + message file. */
  promptFilePath: string,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model?: string,
  /** Optional callback invoked once to reveal the output panel to the user. */
  showOutput?: () => void,
): void {
  showOutput?.();

  const resolvedModel = model || GROK_DEFAULT_MODEL;
  log(`Grok: spawning (model=${resolvedModel})`);

  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }

  _busyRoots.add(root);

  let child: child_process.ChildProcess;
  try {
    child = child_process.spawn(
      GROK_BIN,
      [
        '-m', resolvedModel,
        '--always-approve',
        '--cwd', root,
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
  // Stream stdout — each line is a streaming-json object.
  // -------------------------------------------------------------------------
  const rl = readline.createInterface({ input: child.stdout! });
  // Grok's streaming-json exposes `thought`, `text`, `end` — but NOT tool
  // events (tool use is hidden under --always-approve). So per-tool activity
  // isn't available; we surface the real turn boundaries instead: SessionStart
  // at spawn and Stop/SessionEnd on the `end` event (a genuine grok signal, not
  // synthetic padding). `_endSeen` avoids a duplicate SessionEnd on close.
  let _endSeen = false;

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
      }
    } else if (type === 'error') {
      const errMsg: string = msg.message ?? JSON.stringify(msg);
      log(`Grok error: ${errMsg}`);
      try { fs.appendFileSync(stdoutFile, `\n[Grok error: ${errMsg}]\n`, 'utf8'); } catch { /* ignore */ }
    } else if (type === 'end') {
      // Genuine turn-end from grok's stream → real session boundary.
      _endSeen = true;
      _emitGrokHook(root, 'Stop', {});
      _emitGrokHook(root, 'SessionEnd', { reason: 'completed' });
    }
    // `thought` and other event types stay out of the output file.
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) { log(`Grok stderr: ${text}`); }
  });

  child.on('close', (code: number | null) => {
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

// ---------------------------------------------------------------------------
// closeGrokTuiSession
// Called by taskLoop reset interval — nothing to clear with stateless approach.
// ---------------------------------------------------------------------------
export function closeGrokTuiSession(root: string, _log: (msg: string) => void): void {
  // Stateless per-task execution: no session state to clear.
  void root;
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
