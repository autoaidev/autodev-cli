// Offline smoke — LOOP-agent status truth on a provider HARD-FAILURE.
//
// Bug: `_waitForTaskCompletion` resolves() (not rejects) on a provider hard_fail
// so its cleanup runs, but the caller then fell through the SUCCESS/completion
// path — emitting task_done (TASK_STATE_COMPLETED) + task_progress
// (TASK_STATE_WORKING) right after the honest task_fail (TASK_STATE_FAILED). The
// final office frame was WORKING, so a grok/opencode loop agent showed "working"
// after its task actually failed (e.g. a watchdog kill). Fix: after the wait,
// `taskHardFailedDuringWait(before, after)` detects the [~]-blocked transition and
// the loop skips the completion path + continues — the FAILED frame stands.
//
// This locks (1) the pure guard predicate and (2) the WebhookClient A2A state
// mapping the bug hinges on, plus the contract that a hard-failed task's terminal
// frame is FAILED (never a trailing WORKING). Fully offline (setWsSender captures
// frames; no network). Run: node test/taskFailStatusTruth.smoke.mjs  (after build)
import assert from 'node:assert';

const { taskHardFailedDuringWait } = await import('../out/taskLoop.js');
const { WebhookClient } = await import('../out/webhook.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('taskLoop status truth: hard-failure guard + webhook mapping');

// ---------------------------------------------------------------------------
// 1. The pure guard predicate — only a TRANSITION to blocked during the wait
//    skips the completion path; a clean completion (false→false) runs normally.
// ---------------------------------------------------------------------------
ok('taskHardFailedDuringWait: became blocked during the wait → true (skip completion)', () => {
  assert.strictEqual(taskHardFailedDuringWait(false, true), true);
});
ok('taskHardFailedDuringWait: clean completion (never blocked) → false (run completion)', () => {
  assert.strictEqual(taskHardFailedDuringWait(false, false), false);
});
ok('taskHardFailedDuringWait: already-blocked then completed (true→false) → false', () => {
  assert.strictEqual(taskHardFailedDuringWait(true, false), false);
});
ok('taskHardFailedDuringWait: already blocked, still blocked (true→true) → false (no NEW failure)', () => {
  assert.strictEqual(taskHardFailedDuringWait(true, true), false);
});

// ---------------------------------------------------------------------------
// 2. WebhookClient A2A state mapping — the states the bug hinges on.
// ---------------------------------------------------------------------------
// state extractor: task_done/fail → { task.status.state }; the rest → { statusUpdate.status.state }
const stateOf = (frame) =>
  frame?.task?.status?.state ?? frame?.statusUpdate?.status?.state ?? null;

function capture() {
  const frames = [];
  const wc = new WebhookClient('wss://office.example/ws', 'AGENTKEY', 'ctx-1');
  wc.setWsSender((f) => { frames.push(f); return true; });
  return { wc, frames };
}

ok('event→state mapping: start=WORKING, fail=FAILED, done=COMPLETED, progress=WORKING, all_tasks_done=COMPLETED, rate_limit=STOPPED', () => {
  const { wc, frames } = capture();
  wc.send('task_start', { task: { text: 'T', id: '1' } });
  wc.send('task_fail', { task: { text: 'T', id: '1' }, error: 'provider hard-failure: watchdog' });
  wc.send('task_done', { task: { text: 'T', id: '1' } });
  wc.send('task_progress', { total: 1, remaining: 1 });
  wc.send('all_tasks_done', {});
  wc.send('rate_limit', {});
  const states = frames.map(stateOf);
  assert.deepStrictEqual(states, [
    'TASK_STATE_WORKING', 'TASK_STATE_FAILED', 'TASK_STATE_COMPLETED',
    'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_STOPPED',
  ]);
});

// ---------------------------------------------------------------------------
// 3. The BUG vs the FIX, expressed as the emitted frame sequence.
//    BUG (no guard): start → fail → done → progress ⇒ terminal frame WORKING.
//    FIX (guard skips completion): start → fail ⇒ terminal frame FAILED.
// ---------------------------------------------------------------------------
ok('BUG repro: falling through completion after a hard-fail leaves terminal state WORKING', () => {
  const { wc, frames } = capture();
  wc.send('task_start', { task: { text: 'T', id: '1' } });
  wc.send('task_fail', { task: { text: 'T', id: '1' }, error: 'hard-fail' });
  // Without the guard the loop's success path also fires these two:
  wc.send('task_done', { task: { text: 'T', id: '1' } });
  wc.send('task_progress', { total: 1, remaining: 1 });   // [~] blocked ⇒ remaining>0
  assert.strictEqual(stateOf(frames[frames.length - 1]), 'TASK_STATE_WORKING',
    'demonstrates the stuck-working clobber the guard prevents');
});

ok('FIX contract: guard skips completion ⇒ terminal frame after a hard-fail is FAILED', () => {
  const { wc, frames } = capture();
  wc.send('task_start', { task: { text: 'T', id: '1' } });
  wc.send('task_fail', { task: { text: 'T', id: '1' }, error: 'hard-fail' });
  // taskHardFailedDuringWait(false, true) === true ⇒ the loop `continue`s here,
  // emitting NOTHING further for this task.
  assert.strictEqual(taskHardFailedDuringWait(false, true), true, 'guard fires');
  assert.strictEqual(stateOf(frames[frames.length - 1]), 'TASK_STATE_FAILED',
    'the honest FAILED is the terminal frame — no trailing WORKING');
});

console.log(`\ntaskFailStatusTruth smoke: ${pass} checks passed`);
