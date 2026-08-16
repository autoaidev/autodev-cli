import { ProviderUsage, nonNeg } from '../base/ProviderUsage';
import type { UsagePayload } from '../base/types';

export class OpencodeProviderUsage extends ProviderUsage {
  readonly family = 'opencode';
  readonly defaultContextLimit = 128_000;
  extract(raw: unknown, _model?: string | null): UsagePayload | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const u = raw as Record<string, unknown>;
    const input = nonNeg(u['input'] ?? u['inputTokens'] ?? u['tokens'] ?? 0);
    const output = nonNeg(u['output'] ?? u['outputTokens'] ?? 0);
    const context = nonNeg(u['context'] ?? u['contextTokens']) || input;
    return this.pack(input, output, context, this.defaultContextLimit);
  }
}
