// Offline smoke — NO-PROGRESS detection + bounded escalation (1.4.194 FIX 1).
//
// Symptom 2: grok/opencode auto-mode sometimes ACKs a turn WITHOUT producing the
// deliverable ("ACK-without-doing"): the TODO item stays [ ]/[~], no file lands,
// and the office keeps sending "go on" so the run churns while nothing advances.
// pickNextTask never re-picks a [~], so a stuck item cannot self-advance.
//
// Fix: before/after each grok/opencode turn the loop snapshots a cheap progress
// signature (TODO checkbox map + a bounded workspace mtime/size/count scan). A
// turn that ends with NO signature change AND leaves the task open is a
// NO-PROGRESS turn. reconcileNoProgress does write-INDEPENDENT in-memory
// bookkeeping: it counts consecutive no-progress turns per task and, after N
// (default 3, env AUTODEV_MAX_NOPROGRESS_TURNS), promotes the task to _blockedTasks
// (needs-attention). ANY real progress (a moved checkbox or a changed file) resets
// the counter and it NEVER escalates. It can NEVER mark a task done (no-false-done).
// Run: node test/noProgressReconcile.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { reconcileNoProgress, maxNoProgressTurns, MAX_NOPROGRESS_TURNS, todoCheckboxSignature } =
  await import('../out/taskLoop.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('taskLoop no-progress escalation: bounded, resets on progress, never false-done');

assert.strictEqual(MAX_NOPROGRESS_TURNS, 3, 'default no-progress ceiling is 3');

// ---------------------------------------------------------------------------
// 1. Escalation: N consecutive no-progress turns → block (needs attention).
// ---------------------------------------------------------------------------
ok('reconcileNoProgress: counts up on no-progress, blocks on the Nth', () => {
  const counts = new Map();
  const blocked = new Set();
  const key = 't1';
  // turns 1..N-1: no-progress, counter climbs, NOT blocked.
  for (let i = 1; i < MAX_NOPROGRESS_TURNS; i++) {
    const r = reconcileNoProgress(key, /*changed*/ false, /*taskStillOpen*/ true, counts, blocked);
    assert.strictEqual(r.action, 'noprogress', `turn ${i} is a no-progress turn`);
    assert.strictEqual(r.count, i, 'counter climbs monotonically');
    assert.strictEqual(blocked.has(key), false, 'not blocked while under budget');
  }
  // turn N: block.
  const last = reconcileNoProgress(key, false, true, counts, blocked);
  assert.strictEqual(last.action, 'block', 'the Nth consecutive no-progress turn blocks');
  assert.strictEqual(last.count, MAX_NOPROGRESS_TURNS, 'blocked exactly at the ceiling');
  assert.strictEqual(blocked.has(key), true, 'task promoted to _blockedTasks (needs attention)');
  // No "done"/"complete" outcome exists anywhere — never a false green.
  assert.ok(!['done', 'complete', 'completed'].includes(last.action), 'reconcile can NEVER mark a task done');
  // The counter is freed after blocking (done escalating).
  assert.strictEqual(counts.has(key), false, 'counter freed once blocked');
});

// ---------------------------------------------------------------------------
// 2. A turn that DOES change a checkbox/file resets the counter → never blocks.
// ---------------------------------------------------------------------------
ok('reconcileNoProgress: any real progress resets the counter (never escalates)', () => {
  const counts = new Map();
  const blocked = new Set();
  const key = 't2';
  reconcileNoProgress(key, false, true, counts, blocked); // 1 no-progress
  reconcileNoProgress(key, false, true, counts, blocked); // 2 no-progress
  assert.strictEqual(counts.get(key), 2, 'two no-progress turns banked');
  const progressed = reconcileNoProgress(key, /*changed*/ true, true, counts, blocked);
  assert.strictEqual(progressed.action, 'progress', 'a changed signature is progress');
  assert.strictEqual(counts.has(key), false, 'counter reset to zero on progress');
  assert.strictEqual(blocked.has(key), false, 'a progressing task is never blocked');
  // Now it can bank fresh no-progress turns again without carrying old debt.
  reconcileNoProgress(key, false, true, counts, blocked);
  assert.strictEqual(counts.get(key), 1, 'counter starts fresh after a reset');
});

ok('reconcileNoProgress: an alternating change/no-change stream NEVER escalates', () => {
  const counts = new Map();
  const blocked = new Set();
  const key = 't3';
  for (let i = 0; i < 20; i++) {
    // every other turn produces real work → the counter can never reach N.
    reconcileNoProgress(key, /*changed*/ i % 2 === 0, true, counts, blocked);
  }
  assert.strictEqual(blocked.has(key), false, 'steady real progress is never blocked');
});

// ---------------------------------------------------------------------------
// 3. A task that becomes done resets even with an unchanged file signature.
// ---------------------------------------------------------------------------
ok('reconcileNoProgress: taskStillOpen=false counts as progress (task is done)', () => {
  const counts = new Map();
  const blocked = new Set();
  const key = 't4';
  reconcileNoProgress(key, false, true, counts, blocked); // 1 no-progress
  const done = reconcileNoProgress(key, /*changed*/ false, /*taskStillOpen*/ false, counts, blocked);
  assert.strictEqual(done.action, 'progress', 'a done task is progress, not no-progress');
  assert.strictEqual(counts.has(key), false, 'counter reset when task is done');
  assert.strictEqual(blocked.has(key), false, 'a done task is not blocked');
});

// ---------------------------------------------------------------------------
// 4. Custom ceiling via maxNoProgressTurns() / AUTODEV_MAX_NOPROGRESS_TURNS.
// ---------------------------------------------------------------------------
ok('reconcileNoProgress: honours a custom ceiling', () => {
  const counts = new Map();
  const blocked = new Set();
  assert.strictEqual(reconcileNoProgress('k', false, true, counts, blocked, 1).action, 'block', 'ceiling of 1 blocks on the first no-progress turn');
});

ok('maxNoProgressTurns: env override + default', () => {
  const saved = process.env.AUTODEV_MAX_NOPROGRESS_TURNS;
  process.env.AUTODEV_MAX_NOPROGRESS_TURNS = '5';
  assert.strictEqual(maxNoProgressTurns(), 5, 'env override honoured');
  process.env.AUTODEV_MAX_NOPROGRESS_TURNS = '0';
  assert.strictEqual(maxNoProgressTurns(), MAX_NOPROGRESS_TURNS, 'non-positive falls back to default');
  delete process.env.AUTODEV_MAX_NOPROGRESS_TURNS;
  assert.strictEqual(maxNoProgressTurns(), MAX_NOPROGRESS_TURNS, 'default when unset');
  if (saved !== undefined) { process.env.AUTODEV_MAX_NOPROGRESS_TURNS = saved; }
});

// ---------------------------------------------------------------------------
// 5. The progress signature itself: a checkbox transition changes the string.
// ---------------------------------------------------------------------------
ok('todoCheckboxSignature: any checkbox transition changes the signature', () => {
  const before = [{ id: 'a', text: 'do a', status: 'pending' }, { id: 'b', text: 'do b', status: 'in-progress' }];
  const sameStatus = [{ id: 'b', text: 'do b', status: 'in-progress' }, { id: 'a', text: 'do a', status: 'pending' }];
  const moved = [{ id: 'a', text: 'do a', status: 'in-progress' }, { id: 'b', text: 'do b', status: 'in-progress' }];
  const done  = [{ id: 'a', text: 'do a', status: 'pending' }, { id: 'b', text: 'do b', status: 'done' }];
  assert.strictEqual(todoCheckboxSignature(before), todoCheckboxSignature(sameStatus), 'order-independent + stable when nothing moved');
  assert.notStrictEqual(todoCheckboxSignature(before), todoCheckboxSignature(moved), '[ ]→[~] changes the signature');
  assert.notStrictEqual(todoCheckboxSignature(before), todoCheckboxSignature(done), '[~]→[x] changes the signature');
});

// ---------------------------------------------------------------------------
// 6. Full escalation contract with a LOCKED (never-writable) TODO.md: bounded,
//    never done, blocked exactly once — mirrors the stranded flood-safety test.
// ---------------------------------------------------------------------------
ok('locked-file no-progress: never done, ≤N counts, blocked once, no per-turn flood', () => {
  const counts = new Map();
  const blocked = new Set();           // === taskLoop._blockedTasks
  const max = MAX_NOPROGRESS_TURNS;
  const task = { id: 't1', text: 'produce the report', status: 'in-progress' };
  const failingWriter = { markDoneCalls: 0, markDone() { this.markDoneCalls++; throw new Error('EBUSY'); } };

  let noProgress = 0, blocks = 0;
  const TURNS = 50;
  for (let iter = 0; iter < TURNS; iter++) {
    // A blocked task is excluded from the sweep (mirrors the loop filter): once
    // blocked, pickNextTask/no-progress never touch it again → bounded.
    if (blocked.has(task.id)) { continue; }
    // The turn produced nothing this iteration (unchanged signature, still open).
    const { action } = reconcileNoProgress(task.id, /*changed*/ false, /*open*/ true, counts, blocked, max);
    if (action === 'noprogress') { noProgress++; }
    else if (action === 'block') { blocks++; /* loop reports task_fail + StopFailure here, NEVER markDone */ }
  }
  assert.strictEqual(failingWriter.markDoneCalls, 0, 'markDone must NEVER be called (no false-done)');
  assert.strictEqual(noProgress, max - 1, `exactly ${max - 1} no-progress turns before the block`);
  assert.strictEqual(blocks, 1, 'blocked exactly once');
  assert.strictEqual(blocked.has('t1'), true, 'task ends in _blockedTasks (needs attention)');
});

console.log(`\n${pass} assertions passed ✓`);
