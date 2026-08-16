import { ProviderUsage, nonNeg } from '../base/ProviderUsage';
import type { UsagePayload } from '../base/types';

export class DummyProviderUsage extends ProviderUsage {
  readonly family = 'dummy';
  readonly defaultContextLimit = 128_000;

  extract(raw: unknown, _model?: string | null): UsagePayload | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const u = raw as Record<string, unknown>;
    const input = nonNeg(u['inputTokens'] ?? u['input_tokens']);
    const output = nonNeg(u['outputTokens'] ?? u['output_tokens']);
    const context = nonNeg(u['contextTokens'] ?? u['context_tokens']) || (input + output);
    return this.pack(input, output, context, this.defaultContextLimit);
  }

  /** Synthesize a plausible usage snapshot for a dummy turn. */
  synthesize(promptChars: number): UsagePayload {
    const input = Math.max(80, Math.round(promptChars / 4));
    const output = 240;
    const context = input + 1_200;
    return this.pack(input, output, context, this.defaultContextLimit)!;
  }
}
