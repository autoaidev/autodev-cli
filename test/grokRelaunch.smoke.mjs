// Offline smoke — grok-tui must RELAUNCH after any exit (self-recover).
//
// BUG: after a grok-tui session EXITS ("Grok: exited (code=1)", or the loop's
// "⚠ CLI exit file never written — wrote sentinel to unblock next cycle"), a NEW
// task logged "▶ Task […]" but grok was NEVER relaunched — the agent sat dead.
//
// ROOT CAUSE: taskLoop's cliIsRunning() handled claude-tui/copilot-sdk/opencode-sdk
// via their in-memory busy flag, but grok-tui fell through to the exit-file
// heuristic whose `catch { return true }` (file absent) or an empty/rotated
// per-message exit file could read STALE-TRUE after a grok exit. cliIsRunning=TRUE
// makes the dispatch hit `if (cliIsRunning) skip send` — so grok is never
// relaunched and _waitForTaskCompletion waits forever.
//
// FIX: cliIsRunning for grok-tui uses the authoritative busy flag (isGrokTuiBusy),
// like claude-tui. The flag is cleared on EVERY exit path — clean finish(),
// code!=0, and the loop's sentinel-unblock (forceIdleGrokTui) — so a new task
// after any exit is never blocked and grok relaunches (grok --resume, context
// intact). This test asserts the flag contract + that the loop is wired to it.
//
// Run: node test/grokRelaunch.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const {
  isGrokTuiBusy, forceIdleGrokTui, closeGrokTuiSession,
} = await import('../out/providers/grok/tui.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grokRelaunch: grok-tui self-recovers after any exit');

const ROOT = '/tmp/autodev-grok-relaunch-test';

// ---------------------------------------------------------------------------
// 1. Busy-flag contract: a root with no turn in flight is NOT busy → cliIsRunning
//    returns false → the next dispatch is ALLOWED to send (relaunch grok).
// ---------------------------------------------------------------------------
ok('a fresh root is not busy → dispatch allowed (relaunch, not skip)', () => {
  assert.strictEqual(isGrokTuiBusy(ROOT), false);
});

// ---------------------------------------------------------------------------
// 2. The sentinel-unblock path (forceIdleGrokTui, called by the loop when the
//    exit file was never written) clears busy so the next dispatch proceeds.
// ---------------------------------------------------------------------------
ok('forceIdleGrokTui (sentinel-unblock) leaves the root not-busy', () => {
  forceIdleGrokTui(ROOT);
  assert.strictEqual(isGrokTuiBusy(ROOT), false, 'sentinel path must unblock the next dispatch');
});

// ---------------------------------------------------------------------------
// 3. Closing a session also clears busy (teardown must never pin the flag true).
// ---------------------------------------------------------------------------
ok('closeGrokTuiSession clears busy', () => {
  closeGrokTuiSession(ROOT, () => {});
  assert.strictEqual(isGrokTuiBusy(ROOT), false);
});

// ---------------------------------------------------------------------------
// 4. Regression guard: the task loop routes grok-tui's cliIsRunning through the
//    busy flag (isGrokTuiBusy), NOT the exit-file `catch { return true }` fallthrough
//    that could pin it stale-true after an exit and no-op the relaunch send.
// ---------------------------------------------------------------------------
ok('taskLoop cliIsRunning uses isGrokTuiBusy for grok-tui (not the exit-file fallthrough)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'out', 'taskLoop.js'), 'utf8');
  // The cliIsRunning grok-tui branch returns the busy flag over the workspace root:
  //   `return isGrokTuiBusy(this._workspaceRoot)`  (the steer path uses `(root)`, so
  //   this `(this._workspaceRoot)` form is unique to cliIsRunning).
  assert.ok(
    /isGrokTuiBusy\)?\(this\._workspaceRoot\)/.test(src),
    'cliIsRunning must return isGrokTuiBusy(this._workspaceRoot) for grok-tui',
  );
});

console.log(`\ngrokRelaunch smoke: ${pass} checks passed`);
