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
