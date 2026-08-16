import { ProviderUsage, nonNeg } from '../base/ProviderUsage';
import type { UsagePayload } from '../base/types';

const DEFAULT_COPILOT_CONTEXT_LIMIT = 128_000;

/**
 * Copilot SDK events carry `outputTokens` on assistant.message and sometimes
 * a telemetry block with input/context occupancy. Guard every field.
 */
export function extractCopilotUsage(
  raw: unknown,
  model?: string | null,
): UsagePayload | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const u = raw as Record<string, unknown>;
  const data = (u['data'] && typeof u['data'] === 'object') ? u['data'] as Record<string, unknown> : u;
  const input = nonNeg(data['inputTokens'] ?? data['input_tokens'] ?? data['promptTokens']);
  const output = nonNeg(data['outputTokens'] ?? data['output_tokens'] ?? data['completionTokens']);
  const context = nonNeg(data['contextTokens'] ?? data['context_tokens']) || (input + output);
  if (input === 0 && output === 0 && context === 0) { return null; }
  const limit = /claude|sonnet|opus|haiku/i.test(String(model ?? '')) ? 200_000 : DEFAULT_COPILOT_CONTEXT_LIMIT;
  const rawPct = limit > 0 ? (context / limit) * 100 : 0;
  return {
    tokens: input + output,
    inputTokens: input,
    outputTokens: output,
    contextTokens: context,
    contextPct: Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10)),
  };
}

export class CopilotProviderUsage extends ProviderUsage {
  readonly family = 'copilot';
  readonly defaultContextLimit = DEFAULT_COPILOT_CONTEXT_LIMIT;
  extract(raw: unknown, model?: string | null): UsagePayload | null {
    return extractCopilotUsage(raw, model);
  }
}
