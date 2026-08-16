// ---------------------------------------------------------------------------
// ProviderUsage — turn a provider-native usage block into the compact
// snapshot pixel-office renders (context% + tokens).
// ---------------------------------------------------------------------------

import type { UsagePayload } from './types';

/** Coerce an unknown to a finite, non-negative number, else 0. */
export function nonNeg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Clamp a raw percent to 0..100 with one decimal place. */
export function clampPct(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

export abstract class ProviderUsage {
  abstract readonly family: string;
  abstract readonly defaultContextLimit: number;

  /** Build a usage snapshot from a provider-native payload, or null if empty. */
  abstract extract(raw: unknown, model?: string | null): UsagePayload | null;

  protected pack(input: number, output: number, context: number, limit: number): UsagePayload | null {
    if (input === 0 && output === 0 && context === 0) { return null; }
    return {
      tokens: input + output,
      inputTokens: input,
      outputTokens: output,
      contextTokens: context,
      contextPct: clampPct(limit > 0 ? (context / limit) * 100 : 0),
    };
  }
}
