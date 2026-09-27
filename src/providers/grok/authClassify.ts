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

/**
 * Markers in grok's CAPTURED ERROR TEXT — its stderr, a streaming-json
 * `{type:"error"}` record, an error `turn_ended` detail, or an ACP startup
 * stderr snapshot — that mean grok is NOT SIGNED IN: the token expired /
 * `~/.grok/auth.json` is gone / silent refresh failed and grok fell back to its
 * logged-out gate. On a headless/ACP turn grok prints, e.g.:
 *   "Not signed in. To authenticate without a browser, run: grok login --device-code"
 *   "... set XAI_API_KEY ..."
 *   an xAI API "Unauthorized" / 401 body
 * This can NEVER be retried away — the user must re-login — so a turn that fails
 * with any of these must be surfaced as `reauth_required` (loop pauses, office
 * shows 🔑), NOT hammered with `retry 1/10…10/10`.
 *
 * DISTINCT from GROK_AUTH_MARKERS above, which reads the live INTERACTIVE tmux
 * pane (login gate / Failed(ManualLogin)). This one reads grok's HEADLESS / ACP
 * error surface, where the pane never exists. Callers gate it to a FAILED /
 * non-zero turn so grok's own remediation words appearing inside a *successful*
 * answer ("run grok login to …") can never trip a false reauth.
 *
 * Precision notes (see the unit tests for the negatives):
 *   - "not signed in", "grok login", "--device-code", "XAI_API_KEY" and
 *     "authenticate without a browser" are grok-native logged-out strings that
 *     do not appear in ordinary successful output.
 *   - a bare "401"/"Unauthorized" is required to be near an xai/grok/api-key/
 *     token word (NOT a bare "auth", which appears in ordinary prose like "…401
 *     when the user is not authenticated"), so a 404 "session not found" (NOT
 *     auth) and unrelated 401-in-prose are excluded.
 */
export const GROK_NOT_SIGNED_IN_MARKERS =
  /not signed in|grok login\b|--device[- ]?code\b|\bXAI_API_KEY\b|authenticate without a browser|not (?:logged in|authenticated)\b[^\n]{0,40}(?:log ?in|authenticate|sign ?in|run|\/login)|(?:unauthorized|\b401\b)[^\n]{0,60}(?:xai|grok|api[ _-]?key|token)/i;

/**
 * True when grok's captured error text indicates a NOT-SIGNED-IN / auth failure
 * (non-retryable → reauth_required). Pure; the caller supplies grok's error
 * surface (stderr / error record / ACP stderr snapshot) and gates it to a failed
 * turn. Empty/whitespace input is never a match.
 */
export function isGrokAuthFailure(text: string | null | undefined): boolean {
  const s = String(text ?? '');
  if (!s.trim()) { return false; }
  return GROK_NOT_SIGNED_IN_MARKERS.test(s);
}

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
