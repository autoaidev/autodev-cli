// Offline smoke — the mcp-operate status truth logic (../core/operateStatus).
//
// The bug: an mcp-operate bridge flips the office badge to 'working' on a
// WORKING_HOOK and only decays to 'idle' after a 120s inactivity timer, so a
// finished/ended session lingered as "working" for up to 120s — or forever if
// stray activity kept resetting the timer, or the session torn down. The fix:
//   • a turn-END hook (Stop/session_end/StopFailure/stop_failure/SessionEnd,
//     raw OR normalized) flips to idle IMMEDIATELY, and
//   • every teardown path fires reportIdleOnTeardown() once.
// This drives the pure controller with a synthetic hooks-events.jsonl sequence
// (no socket, no proxy) and a fake timer, and asserts the transitions.
// Run: node test/operateStatus.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { classifyHook, createOperateStatusController, WORKING_HOOKS, TURN_END_HOOKS } =
  await import('../out/core/operateStatus.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// A synchronous fake timer so the 120s inactivity decay can be driven by hand.
function makeFakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    pending: () => timers.size,
  };
}

console.log('operateStatus: turn-end + teardown truth');

// ---------------------------------------------------------------------------
// 1. classifyHook — working vs turn-end vs ignore (raw AND normalized spellings)
// ---------------------------------------------------------------------------
ok('classifyHook: WORKING_HOOKS → working', () => {
  for (const h of WORKING_HOOKS) { assert.strictEqual(classifyHook(h), 'working', h); }
});
ok('classifyHook: turn-end hooks (raw + normalized) → end', () => {
  for (const h of ['Stop', 'StopFailure', 'SessionEnd', 'session_end', 'stop_failure']) {
    assert.strictEqual(classifyHook(h), 'end', h);
    assert.ok(TURN_END_HOOKS.has(h), `${h} in TURN_END_HOOKS`);
  }
});
ok('classifyHook: unrelated / empty → null', () => {
  for (const h of ['Read', 'SessionStart', '', null, undefined]) {
    assert.strictEqual(classifyHook(h), null, String(h));
  }
});

// ---------------------------------------------------------------------------
// 2. Sequence: PreToolUse then Stop (a synthetic hooks-events.jsonl batch)
//    → 'working' reported after PreToolUse, 'idle' reported after Stop.
// ---------------------------------------------------------------------------
ok('PreToolUse → working, then Stop → idle (immediate, not after 120s)', () => {
  const clock = makeFakeClock();
  const reports = [];
  const ctl = createOperateStatusController((s) => reports.push(s), clock);

  // Mirror the bridge tick loop: classify each jsonl line, then apply the batch.
  const jsonl = [
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }),
    JSON.stringify({ hook_event_name: 'Stop' }),
  ].join('\n');

  let sawWork = false, sawEnd = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) { continue; }
    const ev = JSON.parse(line);
    const name = ev.hook_event_name || ev.hook || ev.event || '';
    const kind = classifyHook(name);
    if (kind === 'working') { sawWork = true; }
    else if (kind === 'end') { sawEnd = true; }
  }
  if (sawWork) { ctl.markWorking(); }
  if (sawEnd) { ctl.markTurnEnd(); }

  assert.deepStrictEqual(reports, ['working', 'idle'], 'working then idle');
  assert.strictEqual(ctl.getReported(), 'idle');
  assert.strictEqual(clock.pending(), 0, 'the 120s idle timer was cleared on turn-end');
});

// ---------------------------------------------------------------------------
// 3. Without a Stop, working decays only when the inactivity timer fires.
// ---------------------------------------------------------------------------
ok('PreToolUse alone stays working until the 120s timer fires', () => {
  const clock = makeFakeClock();
  const reports = [];
  const ctl = createOperateStatusController((s) => reports.push(s), clock);
  ctl.markWorking();
  assert.deepStrictEqual(reports, ['working']);
  assert.strictEqual(clock.pending(), 1, 'idle timer armed');
  clock.fireAll();  // simulate 120s elapsing
  assert.deepStrictEqual(reports, ['working', 'idle']);
});

// ---------------------------------------------------------------------------
// 4. Teardown: after markWorking, the teardown path reports idle (once).
// ---------------------------------------------------------------------------
ok('teardown after markWorking reports idle exactly once', () => {
  const clock = makeFakeClock();
  const reports = [];
  const ctl = createOperateStatusController((s) => reports.push(s), clock);
  ctl.markWorking();
  ctl.reportIdleOnTeardown();
  ctl.reportIdleOnTeardown();  // dedupe — no second idle
  assert.deepStrictEqual(reports, ['working', 'idle']);
  assert.strictEqual(clock.pending(), 0, 'teardown cleared the pending idle timer');
});

// ---------------------------------------------------------------------------
// 5. dedupe: repeated working is a single report; idle→working→idle transitions.
// ---------------------------------------------------------------------------
ok('status transitions are deduped (no heartbeat spam)', () => {
  const clock = makeFakeClock();
  const reports = [];
  const ctl = createOperateStatusController((s) => reports.push(s), clock);
  ctl.markWorking();
  ctl.markWorking();
  ctl.markWorking();
  assert.deepStrictEqual(reports, ['working'], 'one working per burst');
  ctl.markTurnEnd();
  ctl.markTurnEnd();
  assert.deepStrictEqual(reports, ['working', 'idle'], 'one idle on end');
});

console.log(`\noperateStatus smoke: ${pass} checks passed`);
