/**
 * Pure helpers for the provider hard-failure retry-with-backoff mechanic.
 *
 * A transient provider turn failure (token blip, timeout, watchdog no-output,
 * crash, "provider stopped or timed out", session-error) must NOT lose the
 * task. The task loop retries the SAME task up to `maxProviderRetries` times
 * (default 10) with exponential backoff before finally reporting it
 * failed/blocked and marking it needs-attention.
 *
 * These two functions are intentionally pure (no I/O, no clock beyond
 * Math.random for jitter) so they can be unit-tested in isolation and reused.
 */

/** Base delay for the first retry, in ms. */
export const RETRY_BASE_MS = 2_000;
/** Growth factor per attempt. */
export const RETRY_FACTOR = 2;
/** Hard cap on any single backoff, in ms. */
export const RETRY_CAP_MS = 120_000;
/** Jitter fraction applied to the (pre-cap) deterministic delay (±15%). */
export const RETRY_JITTER = 0.15;

/**
 * Deterministic (jitter-free) center of the backoff curve for a 1-based attempt:
 *   attempt 1 → 2s, 2 → 4s, 3 → 8s, 4 → 16s, 5 → 32s, 6 → 64s,
 *   7 → 120s (cap), 8 → 120s, 9 → 120s, 10 → 120s.
 * Exposed so tests (and callers that want the schedule) can reason about it
 * without depending on the random jitter.
 */
export function providerRetryBackoffCenterMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = RETRY_BASE_MS * Math.pow(RETRY_FACTOR, n - 1);
  return Math.min(raw, RETRY_CAP_MS);
}

/**
 * Exponential backoff for provider hard-failure retries, with light jitter.
 *
 * `attempt` is 1-based. The deterministic center doubles each attempt until it
 * hits the 120s cap; ±15% jitter is applied around that center, and the result
 * is clamped to [0, RETRY_CAP_MS] AFTER jitter so it can never exceed the cap
 * even on the high side of the jitter band.
 *
 * Because the center doubles (×2) while the jitter band is only ±15%, adjacent
 * attempts' jittered ranges never overlap below the cap — so the schedule is
 * monotonically increasing until it saturates at the cap.
 */
export function providerRetryBackoffMs(attempt: number): number {
  const center = providerRetryBackoffCenterMs(attempt);
  const jitterDelta = center * RETRY_JITTER * (Math.random() * 2 - 1);
  const withJitter = center + jitterDelta;
  return Math.max(0, Math.min(Math.round(withJitter), RETRY_CAP_MS));
}

/**
 * Reasons that are NEVER retried by the backoff mechanic — they own a different
 * handling path and hammering them with retries would be wrong.
 *   - reauth_required: genuine auth/token expiry. The loop already pauses,
 *     notifies (reauth_required event + hook), and resumes on re-auth; burning
 *     10 blind retries against an expired token helps nobody.
 */
const NON_RETRYABLE = new Set<string>(['reauth_required']);

/**
 * Should a provider hard-failure be retried before we give up on the task?
 *
 * Returns true when we still have budget (attempt <= max) AND the reason is a
 * TRANSIENT/retryable provider failure. Every non-reauth hard_fail reason is
 * treated as transient: watchdog / no-output, session-error / session.error,
 * timeout, "provider stopped", crash / exit_nonzero, model-unavailable,
 * startup-exit / session-exit / launch-failed, stop_failure, error, etc.
 *
 * @param reason  the hard_fail reason label from CliExitHandler
 * @param attempt 1-based number of the retry we are about to schedule
 * @param max     maximum number of retries (settings.maxProviderRetries ?? 10)
 */
export function shouldRetryHardFail(reason: string, attempt: number, max: number): boolean {
  if (attempt > max) { return false; }
  const r = String(reason ?? '').trim().toLowerCase();
  if (NON_RETRYABLE.has(r)) { return false; }
  return true;
}
