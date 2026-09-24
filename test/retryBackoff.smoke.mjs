// Offline smoke — provider hard-failure RETRY-with-backoff pure helpers.
//
// Bug: in taskLoop.ts the provider hard_fail branch IMMEDIATELY flagged the task
// [~] blocked + reported task_fail (office → FAILED) + StopFailure hook, with NO
// automatic retry. The main loop's task picker excludes blocked tasks, so a
// TRANSIENT hard-failure (grok auth.json briefly missing → silent-refresh Failed
// → the turn hard-fails / a timeout / watchdog no-output / crash) LOST the task
// until a human re-assigned it. Fix: retry the SAME task up to
// settings.maxProviderRetries (default 10) with exponential backoff BEFORE the
// task is finally reported failed/blocked.
//
// This locks the two PURE helpers the branch relies on:
//   providerRetryBackoffMs(attempt)          — exponential backoff + jitter + cap
//   shouldRetryHardFail(reason, attempt, max) — retryable-reason + budget gate
// and documents the hard_fail-branch CONTRACT (below) that the loop implements.
// Fully offline. Run: node test/retryBackoff.smoke.mjs   (after build)
import assert from 'node:assert';

const {
  providerRetryBackoffMs,
  providerRetryBackoffCenterMs,
  shouldRetryHardFail,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_JITTER,
} = await import('../out/core/retryBackoff.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('retryBackoff: provider hard-failure retry pure helpers');

// ---------------------------------------------------------------------------
// 1. providerRetryBackoffCenterMs — deterministic (jitter-free) schedule.
//    attempts 1..10: 2s,4s,8s,16s,32s,64s,120s(cap),120s,120s,120s
// ---------------------------------------------------------------------------
ok('center schedule doubles from 2s until the 120s cap', () => {
  const centers = [1,2,3,4,5,6,7,8,9,10].map(providerRetryBackoffCenterMs);
  assert.deepStrictEqual(centers, [
    2_000, 4_000, 8_000, 16_000, 32_000, 64_000,
    120_000, 120_000, 120_000, 120_000,
  ]);
  assert.strictEqual(RETRY_BASE_MS, 2_000);
  assert.strictEqual(RETRY_CAP_MS, 120_000);
});
ok('center clamps attempt<1 to the first step (2s)', () => {
  assert.strictEqual(providerRetryBackoffCenterMs(0), 2_000);
  assert.strictEqual(providerRetryBackoffCenterMs(-5), 2_000);
});

// ---------------------------------------------------------------------------
// 2. providerRetryBackoffMs — jitter bounds + never exceeds the cap.
//    Sample each attempt many times; every sample must sit inside the ±15%
//    jitter band around the center AND be <= the cap.
// ---------------------------------------------------------------------------
const SAMPLES = 2_000;
function stats(attempt) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const v = providerRetryBackoffMs(attempt);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

ok('every sample stays within ±15% of the center and never exceeds the cap', () => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const center = providerRetryBackoffCenterMs(attempt);
    const lo = center * (1 - RETRY_JITTER);
    const hi = center * (1 + RETRY_JITTER);
    const { min, max } = stats(attempt);
    assert.ok(min >= Math.floor(lo) - 1, `attempt ${attempt}: min ${min} >= ${lo}`);
    assert.ok(max <= Math.ceil(hi) + 1, `attempt ${attempt}: max ${max} <= ${hi}`);
    assert.ok(max <= RETRY_CAP_MS, `attempt ${attempt}: max ${max} <= cap`);
  }
});

// ---------------------------------------------------------------------------
// 3. Monotonic-until-cap: because the center DOUBLES (×2) while jitter is only
//    ±15%, adjacent attempts' jittered ranges do NOT overlap below the cap — so
//    the WHOLE sampled range of attempt N is strictly below attempt N+1's, up to
//    the point the cap saturates (attempt 6 → 7). At/after the cap the value is
//    pinned to the 120s±15% band and stops increasing.
// ---------------------------------------------------------------------------
ok('sampled ranges are strictly increasing across attempts 1..6 (no overlap)', () => {
  let prevMax = -1;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { min, max } = stats(attempt);
    assert.ok(min > prevMax, `attempt ${attempt}: min ${min} > prev max ${prevMax}`);
    prevMax = max;
  }
});
ok('attempt 6 max sits below attempt 7 min (last pre-cap step still climbs)', () => {
  assert.ok(stats(6).max < stats(7).min);
});
ok('at the cap (attempts 7..10) every sample is <= cap and >= cap*(1-jitter)', () => {
  const floor = Math.floor(RETRY_CAP_MS * (1 - RETRY_JITTER)) - 1;
  for (let attempt = 7; attempt <= 10; attempt++) {
    const { min, max } = stats(attempt);
    assert.ok(max <= RETRY_CAP_MS, `attempt ${attempt}: max <= cap`);
    assert.ok(min >= floor, `attempt ${attempt}: min ${min} >= ${floor}`);
  }
});

// ---------------------------------------------------------------------------
// 4. shouldRetryHardFail — retryable-reason + budget gate.
//    EXCLUDE reauth_required (own pause/resume path). Treat every other
//    non-reauth hard_fail reason as TRANSIENT/retryable while under budget.
// ---------------------------------------------------------------------------
ok('reauth_required is NEVER retried (even on attempt 1, any budget)', () => {
  assert.strictEqual(shouldRetryHardFail('reauth_required', 1, 10), false);
  assert.strictEqual(shouldRetryHardFail('reauth_required', 5, 10), false);
  // case/whitespace-insensitive
  assert.strictEqual(shouldRetryHardFail('  Reauth_Required ', 1, 10), false);
});
ok('a transient reason under budget → true', () => {
  for (const reason of [
    'watchdog', 'session-error', 'session.error', 'timeout', 'provider stopped',
    'crash', 'exit_nonzero', 'model-unavailable', 'startup-exit', 'session-exit',
    'launch-failed', 'stop_failure', 'error', '',
  ]) {
    assert.strictEqual(shouldRetryHardFail(reason, 1, 10), true, `reason=${reason}`);
    assert.strictEqual(shouldRetryHardFail(reason, 10, 10), true, `reason=${reason} at budget edge`);
  }
});
ok('over budget (attempt > max) → false, whatever the reason', () => {
  assert.strictEqual(shouldRetryHardFail('watchdog', 11, 10), false);
  assert.strictEqual(shouldRetryHardFail('timeout', 4, 3), false);
});
ok('budget of 10 gives exactly 10 retries then the 11th hard-fail gives up', () => {
  const max = 10;
  let retries = 0;
  for (let attempt = 1; attempt <= 20; attempt++) {
    if (shouldRetryHardFail('timeout', attempt, max)) retries++;
    else { assert.strictEqual(attempt, 11, 'gives up on the 11th hard-failure'); break; }
  }
  assert.strictEqual(retries, 10, 'exactly 10 backoff retries before giving up');
});

// ---------------------------------------------------------------------------
// 5. hard_fail-branch CONTRACT (documented + asserted at the helper level).
//    Under budget for a retryable reason, the loop MUST:
//      - NOT add the task to _blockedTasks, NOT report task_fail / StopFailure
//      - keep it [~] (markInProgress) + queue it in _pendingRetry (re-dispatchable)
//      - report a SOFT task_progress note "retrying (N/10)" (office stays WORKING)
//      - wait providerRetryBackoffMs(attempt), then resolve → loop re-dispatches
//    At exhaustion (11th) OR a non-retryable reason it MUST fall through to the
//    existing behavior: _blockedTasks.add + task_fail (office FAILED) + StopFailure
//    hook + needs-attention, with the exhausted retry count in the message.
//    These two predicates are the exact gate the branch switches on:
// ---------------------------------------------------------------------------
ok('CONTRACT: retry path taken iff shouldRetryHardFail(reason, attempt, max) is true', () => {
  const max = 10;
  // transient + under budget → retry (soft, no block/fail)
  assert.strictEqual(shouldRetryHardFail('watchdog', 3, max), true);
  // transient + budget exhausted → give up (block + task_fail)
  assert.strictEqual(shouldRetryHardFail('watchdog', 11, max), false);
  // reauth → give up immediately (block + task_fail), never hammered
  assert.strictEqual(shouldRetryHardFail('reauth_required', 1, max), false);
});

console.log(`\nretryBackoff smoke: ${pass} checks passed`);
