// ---------------------------------------------------------------------------
// Rate-limit detection — central registry of phrases Claude uses to signal
// throttling, plus the reset-time parser. Add new wording in ONE place
// (RateLimitDetector.PHRASES) and every call site picks it up.
// ---------------------------------------------------------------------------

export class RateLimitError extends Error {
  constructor(readonly rawMessage: string, readonly resetAt: Date | undefined) {
    super(rawMessage);
    this.name = 'RateLimitError';
  }
}

/**
 * Phrases / regexes that mean "Claude is throttled, pause the loop". Each
 * entry is matched case-insensitively against the candidate text. Add new
 * wording here whenever Anthropic ships a new error string — no other site
 * in the codebase needs to change.
 */
const PHRASES: ReadonlyArray<RegExp> = [
  // High-signal Anthropic reset banners — these carry the reset time and never
  // false-positive against ordinary assistant prose.
  /hit your limit/i,                // "You've hit your limit · resets 9pm (Europe/Sofia)"
  /out of extra usage/i,            // "You're out of extra usage · resets 8:20pm (Europe/Sofia)"
  /usage limit reached/i,
  // "rate limit" ONLY in its throttle-banner form — bare /rate limit/i matched
  // ordinary text like "I added rate limiting" or "the rate limit is 100 req/s",
  // pausing the loop for minutes/hours with no actual throttling. Require the
  // provider's error/banner context.
  /api error[^\n]{0,120}rate limit/i,   // "API Error: 429 ... rate limit(ed)"
  /·\s*rate limited/i,                  // "... · Rate limited" suffix banner
];

/**
 * Raised when the provider CLI reports it is logged out / unauthenticated /
 * out of credit — a state the loop must NOT treat as task failure. Unlike a
 * rate limit there is no reset time: the loop pauses indefinitely and asks the
 * operator to re-authenticate.
 */
export class AuthError extends Error {
  constructor(readonly rawMessage: string) {
    super(rawMessage);
    this.name = 'AuthError';
  }
}

/**
 * Phrases that mean "the CLI is not authenticated / out of credit". These are
 * high-signal provider error strings (invalid key, expired/revoked token,
 * /login prompt, low balance) that never appear in ordinary assistant prose,
 * so they are safe to match case-insensitively across the captured output.
 */
const AUTH_PHRASES: ReadonlyArray<RegExp> = [
  /invalid api key/i,                                    // Claude: "Invalid API key · Please run /login"
  /credit balance is too low/i,                          // Anthropic out-of-credit banner
  /please run\s+\/login/i,                               // explicit re-login instruction
  /oauth token[^\n]{0,60}(expired|revoked|invalid)/i,    // token lifecycle failure
  /authentication_error/i,                               // Anthropic API error type
  // "not logged in / authenticated" only when paired with a re-auth instruction
  // (a bare mention appears in ordinary code the agent writes).
  /not (logged in|authenticated)[^\n]{0,40}(log ?in|authenticate|run|sign in|\/login)/i,
];

export class AuthDetector {
  /** True when text contains any known auth-failure phrase. */
  static matches(text: string): boolean {
    if (!text) { return false; }
    return AUTH_PHRASES.some(p => p.test(text));
  }

  /** Build an AuthError from text, or null when text is not an auth failure. */
  static detect(text: string): AuthError | null {
    if (!AuthDetector.matches(text)) { return null; }
    return new AuthError((text ?? '').trim() || 'Authentication required');
  }
}

export class RateLimitDetector {
  /** True when text contains any known rate-limit phrase. */
  static matches(text: string): boolean {
    if (!text) { return false; }
    return PHRASES.some(p => p.test(text));
  }

  /** Build a RateLimitError from text, parsing the reset time if present. */
  static toError(text: string): RateLimitError {
    const trimmed = (text ?? '').trim();
    return new RateLimitError(trimmed || 'Rate limited', RateLimitDetector.parseResetTime(trimmed));
  }

  /** Match + build in one step. Returns null when text is not a rate limit. */
  static detect(text: string): RateLimitError | null {
    return RateLimitDetector.matches(text) ? RateLimitDetector.toError(text) : null;
  }

  /**
   * Parse "resets 9pm (Europe/Sofia)" / "resets 8:20pm (Europe/Sofia)" into a
   * UTC Date. Returns undefined when no reset clause is present or parseable.
   */
  static parseResetTime(text: string): Date | undefined {
    const m = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
    if (!m) { return undefined; }
    try {
      let hour = parseInt(m[1]);
      const min = parseInt(m[2] ?? '0');
      const isPm = m[3].toLowerCase() === 'pm';
      const tz = m[4];
      if (isPm && hour !== 12) { hour += 12; }
      if (!isPm && hour === 12) { hour = 0; }
      const now = new Date();
      const dateStr = new Intl.DateTimeFormat('sv', { timeZone: tz }).format(now);
      for (let d = 0; d <= 1; d++) {
        const base = Date.parse(dateStr) + d * 86_400_000 + hour * 3_600_000 + min * 60_000;
        const naiveDate = new Date(base);
        const inTz = new Date(naiveDate.toLocaleString('en-US', { timeZone: tz }));
        const offset = naiveDate.getTime() - inTz.getTime();
        const resetUtc = new Date(base + offset);
        if (resetUtc > now) { return resetUtc; }
      }
      return undefined;
    } catch { return undefined; }
  }
}
