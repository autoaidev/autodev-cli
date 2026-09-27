// Offline smoke — grok turn-outcome classification: an AUTH failure (needs
// re-login, NEVER retried) vs a TRANSIENT turn failure (retryable with backoff).
//
// Root cause (proven from real grok logs on a user's Windows box): `~/.grok/
// auth.json` intermittently goes MISSING → grok logs `auth: silent refresh` →
// `outcome: Failed(ManualLogin)` → the turn dies and grok prints its native
// banner "Turn failed: Grok stopped before this turn finished (the agent process
// exited or was restarted). Committed tool results were kept." The old grok-tui
// detector matched only the OAuth login gate, so this slipped through as a plain
// turn-failure — or, when the pane just went quiet, a FALSE idle (lost task).
//
// This locks the PURE classifier the provider now uses (classifyGrokTurn) plus
// the two policy predicates that keep reauth and transient-retry DISTINCT:
//   - AuthDetector matches grok's reauth sentinel + Failed(ManualLogin)  (loop
//     reauth PAUSE), and
//   - shouldRetryHardFail retries 'turn-failed' but NEVER 'reauth_required'.
// Fully offline. Run: node test/grokAuthClassify.smoke.mjs   (after build)
import assert from 'node:assert';

const {
  classifyGrokTurn,
  GROK_AUTH_MARKERS,
  GROK_TURN_FAIL_MARKERS,
  GROK_REAUTH_MESSAGE,
  isGrokAuthFailure,
  GROK_NOT_SIGNED_IN_MARKERS,
} = await import('../out/providers/grok/authClassify.js');
const { AuthDetector } = await import('../out/rateLimit.js');
const { shouldRetryHardFail } = await import('../out/core/retryBackoff.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grok auth-classify smoke');

// The exact grok-native banner from the failing box (auth.json missing case).
const GROK_TURN_FAIL_BANNER =
  'Turn failed: Grok stopped before this turn finished (the agent process exited or was restarted). Committed tool results were kept.';

// ---------------------------------------------------------------------------
// 1. AUTH failures → 'reauth' regardless of the auth-file check.
// ---------------------------------------------------------------------------
ok('Failed(ManualLogin) in the pane → reauth (auth present OR absent)', () => {
  const pane = 'auth: silent refresh\noutcome: Failed(ManualLogin)';
  assert.strictEqual(classifyGrokTurn(pane, true), 'reauth');
  assert.strictEqual(classifyGrokTurn(pane, false), 'reauth');
});
ok('failed silent refresh → reauth', () => {
  assert.strictEqual(classifyGrokTurn('token silent refresh failed', true), 'reauth');
});
ok('interactive login gate → reauth', () => {
  for (const s of ['Please log in to continue', 'waiting for approval', 'finish signing in', 'enter the device code']) {
    assert.strictEqual(classifyGrokTurn(s, true), 'reauth', s);
  }
});
ok('manual login prompt → reauth', () => {
  assert.strictEqual(classifyGrokTurn('manual login required', true), 'reauth');
  assert.strictEqual(classifyGrokTurn('manual-login required', true), 'reauth');
});

// ---------------------------------------------------------------------------
// 2. The KEY disambiguation: grok's turn-failure banner.
//    auth PRESENT → transient 'turn-failed' (retryable).
//    auth ABSENT  → 'reauth' (the proven root cause: auth.json vanished).
// ---------------------------------------------------------------------------
ok('turn-failure banner + auth present → transient turn-failed (retryable)', () => {
  assert.strictEqual(classifyGrokTurn(GROK_TURN_FAIL_BANNER, true), 'turn-failed');
});
ok('turn-failure banner + auth ABSENT → reauth (auth.json missing)', () => {
  assert.strictEqual(classifyGrokTurn(GROK_TURN_FAIL_BANNER, false), 'reauth');
});
ok('GROK_TURN_FAIL_MARKERS matches the native banner', () => {
  assert.ok(GROK_TURN_FAIL_MARKERS.test(GROK_TURN_FAIL_BANNER));
});

// ---------------------------------------------------------------------------
// 3. A healthy, still-producing turn is NEVER flagged — even if we could not
//    stat auth.json (authPresent=false). No banner ⇒ null ⇒ normal idle path.
// ---------------------------------------------------------------------------
ok('benign pane (no banner) → null even with authPresent=false', () => {
  const pane = 'Reading src/index.ts…\nWorked for 4.1s.\n❯';
  assert.strictEqual(classifyGrokTurn(pane, false), null);
  assert.strictEqual(classifyGrokTurn(pane, true), null);
});
ok('empty / undefined snapshot → null', () => {
  assert.strictEqual(classifyGrokTurn('', true), null);
  assert.strictEqual(classifyGrokTurn(undefined, false), null);
});
ok('GROK_AUTH_MARKERS does NOT match ordinary prose', () => {
  assert.ok(!GROK_AUTH_MARKERS.test('I refactored the authentication module and added tests.'));
  assert.ok(!GROK_AUTH_MARKERS.test('the session expired token cache was cleared'));
});

// ---------------------------------------------------------------------------
// 4. Loop reauth PAUSE hinges on AuthDetector matching the grok surface. Before
//    this fix NEITHER the reauth sentinel NOR Failed(ManualLogin) matched, so a
//    logged-out grok never reached the loop's reauth pause (🔑 state).
// ---------------------------------------------------------------------------
ok('AuthDetector matches the grok reauth sentinel', () => {
  assert.ok(AuthDetector.matches(`[Grok TUI: ${GROK_REAUTH_MESSAGE}]`));
  assert.ok(AuthDetector.detect(`[Grok TUI: ${GROK_REAUTH_MESSAGE}]`) !== null);
});
ok('AuthDetector matches Failed(ManualLogin)', () => {
  assert.ok(AuthDetector.matches('outcome: Failed(ManualLogin)'));
});
ok('AuthDetector still ignores ordinary auth-prose (no false pause)', () => {
  assert.ok(!AuthDetector.matches('I added handling for the authentication_error case'));
});

// ---------------------------------------------------------------------------
// 5. Policy: reauth and transient-retry stay DISTINCT.
//    'turn-failed' is retried with backoff; 'reauth_required' is NEVER retried.
// ---------------------------------------------------------------------------
ok('transient turn-failed IS retryable under budget', () => {
  assert.strictEqual(shouldRetryHardFail('turn-failed', 1, 10), true);
  assert.strictEqual(shouldRetryHardFail('turn-failed', 10, 10), true);
  assert.strictEqual(shouldRetryHardFail('turn-failed', 11, 10), false); // budget exhausted
});
ok('reauth_required is NEVER retried (distinct pause/re-login path)', () => {
  assert.strictEqual(shouldRetryHardFail('reauth_required', 1, 10), false);
});

// ---------------------------------------------------------------------------
// 6. NEW: the HEADLESS / ACP not-signed-in surface (grok token expired). The
//    1.4.187 error-surfacing revealed grok's real reason in the log:
//      "Not signed in. To authenticate without a browser, run: grok login --device-code"
//    but it was treated as a generic retryable error → `retry 1/10…10/10`. The
//    classifier + AuthDetector now recognize it so the loop pauses into reauth
//    instead of spinning. Precision: a normal tool error / a 404 session-not-found
//    (NOT auth) must NOT match.
// ---------------------------------------------------------------------------
const GROK_NOT_SIGNED_IN =
  'Not signed in. To authenticate without a browser, run: grok login --device-code';

ok('isGrokAuthFailure: the live "Not signed in … grok login --device-code" banner', () => {
  assert.ok(isGrokAuthFailure(GROK_NOT_SIGNED_IN));
  assert.ok(GROK_NOT_SIGNED_IN_MARKERS.test(GROK_NOT_SIGNED_IN));
});
ok('isGrokAuthFailure: XAI_API_KEY guidance', () => {
  assert.ok(isGrokAuthFailure('Error: not authenticated. Set XAI_API_KEY or run grok login.'));
  assert.ok(isGrokAuthFailure('set the XAI_API_KEY environment variable'));
});
ok('isGrokAuthFailure: bare --device-code / grok login remediation', () => {
  assert.ok(isGrokAuthFailure('run: grok login'));
  assert.ok(isGrokAuthFailure('pass --device-code to sign in'));
});
ok('isGrokAuthFailure: an xAI 401 / Unauthorized (guarded)', () => {
  assert.ok(isGrokAuthFailure('xAI API returned 401 Unauthorized: invalid api key'));
  assert.ok(isGrokAuthFailure('Unauthorized: your xAI token is invalid'));
});
ok('isGrokAuthFailure: NEGATIVE — a normal tool error is not auth', () => {
  assert.ok(!isGrokAuthFailure('tool_output_error: ENOENT: no such file or directory'));
  assert.ok(!isGrokAuthFailure('TypeError: cannot read properties of undefined'));
});
ok('isGrokAuthFailure: NEGATIVE — 404 session-not-found is NOT auth', () => {
  assert.ok(!isGrokAuthFailure('Session 01a0d333 not found locally … 404 Not Found'));
});
ok('isGrokAuthFailure: NEGATIVE — empty / whitespace / undefined', () => {
  assert.ok(!isGrokAuthFailure(''));
  assert.ok(!isGrokAuthFailure('   '));
  assert.ok(!isGrokAuthFailure(undefined));
  assert.ok(!isGrokAuthFailure(null));
});
ok('isGrokAuthFailure: NEGATIVE — ordinary prose mentioning a bare 401/auth', () => {
  // No xai/grok/key/token/auth qualifier next to the number → not flagged.
  assert.ok(!isGrokAuthFailure('the endpoint returns 404 on a missing record'));
  assert.ok(!isGrokAuthFailure('I refactored the login form component'));
});

// The whole point: the loop's AuthDetector (run on grok's non-zero stdout capture)
// now raises an AuthError for the not-signed-in surface → the reauth PAUSE, not a retry.
ok('AuthDetector matches the not-signed-in surface (→ loop reauth pause)', () => {
  assert.ok(AuthDetector.matches(GROK_NOT_SIGNED_IN));
  assert.ok(AuthDetector.matches(`[Grok error: ${GROK_NOT_SIGNED_IN}]`));
  assert.ok(AuthDetector.detect(GROK_NOT_SIGNED_IN) !== null);
});
ok('AuthDetector still ignores a 404 session-not-found (no false pause)', () => {
  assert.ok(!AuthDetector.matches('Session 01a0d333 not found locally … 404 Not Found'));
});

console.log(`\ngrok auth-classify smoke: ${pass} checks passed`);
