// ---------------------------------------------------------------------------
// Pure classifiers for grok turn-end signals.
//
// A grok turn can end three ways we care about:
//   - AUTH failure  → grok is not logged in: `~/.grok/auth.json` went missing,
//                     its silent token refresh failed, or grok fell back to a
//                     manual-login gate (`Failed(ManualLogin)`). This can NEVER
//                     be retried away — the user must re-login — so it must be
//                     surfaced as `reauth_required` (the loop pauses + the office
//                     shows the 🔑 needs-auth state), NOT hammered with retries.
//   - TRANSIENT turn failure → grok printed its native banner "Turn failed: Grok
//                     stopped before this turn finished (the agent process exited
//                     or was restarted)" while credentials are still present. The
//                     process blipped; the turn is retryable with backoff.
//   - neither       → no failure signal in this snapshot.
//
// These functions are intentionally PURE (no I/O) so tui.ts and the unit tests
// share the exact same detection. tui.ts supplies the live pane snapshot and the
// `~/.grok/auth.json` presence check; this module decides the outcome.
// ---------------------------------------------------------------------------

/**
 * Markers that mean grok hit an AUTH gate / failure rather than doing work:
 *   - the interactive OAuth/login gate (waiting for approval / device code / …)
 *   - grok's manual-login fallback outcome `Failed(ManualLogin)`
 *   - a failed silent token refresh
 *   - an explicit "please log in" / "manual login required" prompt
 * Calibrated to grok's own strings; the loose "not logged in" / "session
 * expired" prose is deliberately EXCLUDED so ordinary assistant output rendered
 * in the pane can't trip a false reauth. The deterministic backstop for the
 * proven root cause (auth.json missing) is the auth-file presence check the
 * caller passes in, not a prose match.
 */
export const GROK_AUTH_MARKERS =
  /waiting for approval|approve in your browser|sign(?:ing)? in to grok|finish signing in|device code|please (?:log ?in|sign ?in)|manual[- ]?login(?: required)?|Failed\(\s*ManualLogin\s*\)|silent refresh (?:failed|error)/i;

/**
 * grok's NATIVE turn-failure banner. This is grok-native text (not something
 * autodev prints): grok emits it when its own turn/process is interrupted —
 * "Turn failed: Grok stopped before this turn finished (the agent process
 * exited or was restarted). Committed tool results were kept." On its own this
 * is a TRANSIENT failure; only when credentials are ALSO absent is it auth.
 */
export const GROK_TURN_FAIL_MARKERS =
  /turn failed:|stopped before this turn finished|the agent process (?:exited|was restarted)/i;

/**
 * The sentinel autodev writes to the grok stdout capture + the human-facing
 * message on an auth failure. It contains the phrase `reauthentication required`
 * which rateLimit.ts's AuthDetector matches, so the LOOP raises an AuthError and
 * takes its dedicated reauth PAUSE (webhook + hooks-events 🔑 state) rather than
 * reporting a generic hard-failure.
 */
export const GROK_REAUTH_MESSAGE =
  'reauthentication required — grok is not logged in (auth.json missing / manual login). Please run: grok login';

export type GrokTurnClass = 'reauth' | 'turn-failed' | null;

/**
 * Classify a grok pane snapshot + auth-file state into a turn outcome.
 *
 *  - 'reauth'      → an AUTH failure (login gate, Failed(ManualLogin), failed
 *                    refresh, OR a turn-failure banner while auth.json is
 *                    absent). NEVER retried; surfaced as reauth_required.
 *  - 'turn-failed' → a TRANSIENT turn failure (grok's process exited/restarted
 *                    mid-turn) with credentials present. Retryable with backoff.
 *  - null          → no failure signal.
 *
 * `authPresent` = does `~/.grok/auth.json` exist and is it non-empty. A missing
 * auth.json is itself the proven root cause (grok's silent refresh →
 * Failed(ManualLogin) → the turn dies), so ANY turn-failure banner seen while
 * auth is absent is treated as reauth, not a transient blip. Auth presence only
 * DISAMBIGUATES an actual failure banner — a healthy, still-producing turn (no
 * banner) is never flagged, so a mis-located auth.json can't brick a good turn.
 */
export function classifyGrokTurn(snapshot: string, authPresent: boolean): GrokTurnClass {
  const s = snapshot || '';
  if (GROK_AUTH_MARKERS.test(s)) { return 'reauth'; }
  if (GROK_TURN_FAIL_MARKERS.test(s)) { return authPresent ? 'turn-failed' : 'reauth'; }
  return null;
}
