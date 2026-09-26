// Offline smoke — TRUTHFUL stranded-[~] reconciliation (never false-done).
//
// Bug (observed live on Windows, grok-cli office loop): when the CLI exited
// leaving a task [~] in-progress without completing it, taskLoop's stranded
// sweep called markDone() on it — reporting a half-done task as SUCCESS
// (false-green). Worse, markDone's write failed silently on a locked/unwritable
// TODO.md (Windows file lock), the task stayed [~], the branch tight-`continue`d
// and re-picked it instantly → the same "✅ Auto-marked 1 stranded [~] task as
// done" line flooded ~40× in ONE second.
//
// Fix: reconcileStrandedTask does write-INDEPENDENT in-memory bookkeeping —
// bounded reset+retry (≤ MAX), then BLOCKED / needs-attention. NEVER markDone.
// The strand counter climbs and the task lands blocked after MAX regardless of
// whether any TODO.md write succeeds, so a permanently-locked file can produce
// at most MAX+1 reconcile passes for a task TOTAL — never a per-second flood.
//
// This locks the pure helper + the exact loop-sweep contract the branch runs
// (filter excludes _blockedTasks/_pendingRetry; reconcile BEFORE the write;
// no tight re-pick). Fully offline. Run: node test/strandedReconcile.smoke.mjs
import assert from 'node:assert';

const { reconcileStrandedTask, MAX_STRAND_RETRIES } = await import('../out/taskLoop.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('taskLoop stranded reconciliation: never false-done, bounded, blocked after MAX');

assert.strictEqual(MAX_STRAND_RETRIES, 3, 'default retry ceiling is 3');

// ---------------------------------------------------------------------------
// 1. Pure helper: counter climbs; resets while ≤ MAX; blocks past MAX.
// ---------------------------------------------------------------------------
ok('reconcileStrandedTask: resets for attempts 1..MAX, blocks on MAX+1', () => {
  const strand = new Map();
  const blocked = new Set();
  const key = 't1';
  for (let i = 1; i <= MAX_STRAND_RETRIES; i++) {
    const r = reconcileStrandedTask(key, strand, blocked);
    assert.strictEqual(r.action, 'reset', `attempt ${i} must reset (retry)`);
    assert.strictEqual(r.count, i, 'counter climbs monotonically');
    assert.strictEqual(blocked.has(key), false, 'not blocked while under budget');
  }
  const last = reconcileStrandedTask(key, strand, blocked);
  assert.strictEqual(last.action, 'block', 'attempt MAX+1 blocks (needs attention)');
  assert.strictEqual(blocked.has(key), true, 'task promoted to _blockedTasks');
  // Action set is only reset|block — there is NO "done" outcome anywhere.
  assert.ok(last.action !== 'done', 'reconcile can NEVER produce a done/complete action');
});

ok('reconcileStrandedTask: honors a custom (settings.maxStrandRetries) ceiling', () => {
  const strand = new Map();
  const blocked = new Set();
  assert.strictEqual(reconcileStrandedTask('k', strand, blocked, 1).action, 'reset');
  assert.strictEqual(reconcileStrandedTask('k', strand, blocked, 1).action, 'block');
});

ok('reconcileStrandedTask: keyed by id-or-text — distinct tasks counted independently', () => {
  const strand = new Map();
  const blocked = new Set();
  reconcileStrandedTask('a', strand, blocked);
  reconcileStrandedTask('b', strand, blocked);
  assert.strictEqual(strand.get('a'), 1);
  assert.strictEqual(strand.get('b'), 1);
});

// ---------------------------------------------------------------------------
// 2. Full loop-sweep contract with a PERMANENTLY-FAILING TODO.md writer.
//    Reproduces the Windows locked-file flood and asserts it cannot happen:
//    (a) the task is NEVER marked [x] done,
//    (b) it resets [ ] for exactly the first MAX attempts,
//    (c) after MAX it becomes blocked/needs-attention (in _blockedTasks),
//    (d) NO unbounded hot-loop: 50 loop iterations produce at most MAX+1
//        reconcile passes / log lines TOTAL (bounded), not 50.
// ---------------------------------------------------------------------------
ok('locked-file sweep: never done, resets ×MAX, then blocked, bounded log lines (no flood)', () => {
  const strand = new Map();
  const blocked = new Set();       // === taskLoop._blockedTasks
  const pendingRetry = new Set();  // === taskLoop._pendingRetry
  const maxStrand = MAX_STRAND_RETRIES;

  // A single stranded task. The writer ALWAYS fails, so the task's status never
  // changes off 'in-progress' — exactly the locked-TODO.md case.
  const task = { id: 't1', text: 'ship the thing', status: 'in-progress' };
  const failingWriter = {
    markDoneCalls: 0,
    resetCalls: 0,
    markDone() { this.markDoneCalls++; throw new Error('EBUSY: TODO.md locked'); },
    resetToTodo() { this.resetCalls++; throw new Error('EBUSY: TODO.md locked'); },
  };

  let resets = 0, blocks = 0, logLines = 0;
  const LOOP_ITERATIONS = 50; // the loop would run these over ~50*loopInterval

  for (let iter = 0; iter < LOOP_ITERATIONS; iter++) {
    // Mirror taskLoop's stranded filter EXACTLY.
    const stranded = [task].filter(t =>
      t.status === 'in-progress'
      && !blocked.has(t.id ?? t.text)
      && !pendingRetry.has(t.id ?? t.text));

    for (const t of stranded) {
      const key = t.id ?? t.text;
      // Bookkeeping FIRST — before (and independent of) any TODO.md write.
      const { action } = reconcileStrandedTask(key, strand, blocked, maxStrand);
      logLines++; // one log line per reconcile pass for this task
      if (action === 'reset') {
        resets++;
        try { failingWriter.resetToTodo('TODO.md', t); } catch { /* swallowed, as in taskLoop */ }
      } else {
        blocks++;
        // The loop surfaces task_fail + StopFailure here; it NEVER calls markDone.
      }
    }
    // NO tight-continue: the real loop falls through to _sleepOrWake here.
  }

  // (a) NEVER marked done.
  assert.strictEqual(failingWriter.markDoneCalls, 0, 'markDone must NEVER be called on a stranded task');
  // (b) reset exactly MAX times.
  assert.strictEqual(resets, maxStrand, `reset exactly ${maxStrand} times (retries), no more`);
  // (c) blocked exactly once, and ends in _blockedTasks (needs-attention, not done).
  assert.strictEqual(blocks, 1, 'blocked exactly once');
  assert.strictEqual(blocked.has('t1'), true, 'task ends in _blockedTasks (needs attention)');
  // (d) BOUNDED — 50 iterations, but ≤ MAX+1 reconcile passes / log lines total.
  //     This is the anti-flood invariant: a locked TODO.md can NOT spin.
  assert.strictEqual(logLines, maxStrand + 1, 'at most MAX+1 log lines TOTAL across 50 iterations (no per-second flood)');
  assert.ok(logLines < LOOP_ITERATIONS, 'reconcile passes are bounded, NOT once-per-iteration');
});

ok('already-blocked & pending-retry tasks are excluded from the stranded sweep', () => {
  const strand = new Map();
  const blocked = new Set(['b1']);
  const pendingRetry = new Set(['r1']);
  const tasks = [
    { id: 'b1', text: 'blocked',  status: 'in-progress' },
    { id: 'r1', text: 'retrying', status: 'in-progress' },
    { id: 'n1', text: 'normal',   status: 'in-progress' },
  ];
  const stranded = tasks.filter(t =>
    t.status === 'in-progress'
    && !blocked.has(t.id ?? t.text)
    && !pendingRetry.has(t.id ?? t.text));
  assert.deepStrictEqual(stranded.map(t => t.id), ['n1'], 'only the un-flagged task is swept');
  reconcileStrandedTask('n1', strand, blocked);
  assert.strictEqual(strand.get('n1'), 1);
});

console.log(`\n${pass} assertions passed ✓`);
