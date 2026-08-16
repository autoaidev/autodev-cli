import { ProviderUsage, nonNeg } from '../base/ProviderUsage';
import type { UsagePayload } from '../base/types';

export class GrokProviderUsage extends ProviderUsage {
  readonly family = 'grok';
  readonly defaultContextLimit = 256_000;
  extract(raw: unknown, _model?: string | null): UsagePayload | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const u = raw as Record<string, unknown>;
    const input = nonNeg(u['input_tokens'] ?? u['inputTokens']);
    const output = nonNeg(u['output_tokens'] ?? u['outputTokens']);
    const context = nonNeg(u['context_tokens'] ?? u['contextTokens']) || (input + output);
    return this.pack(input, output, context, this.defaultContextLimit);
  }
}
