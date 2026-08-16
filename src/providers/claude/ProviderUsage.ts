// ---------------------------------------------------------------------------
// Claude usage — derive a running token / context-window snapshot from a
// transcript assistant message's `message.usage` block.
// ---------------------------------------------------------------------------

import { ProviderUsage, nonNeg } from '../base/ProviderUsage';
import type { UsagePayload } from '../base/types';
import { DEFAULT_CLAUDE_CONTEXT_LIMIT } from './ProviderModels';

const CLAUDE_CONTEXT_LIMITS: Array<[RegExp, number]> = [
  [/opus/i, 200_000],
  [/sonnet/i, 200_000],
  [/haiku/i, 200_000],
];

export { DEFAULT_CLAUDE_CONTEXT_LIMIT };

export function contextLimitForModel(model?: string | null): number {
  if (model) {
    for (const [re, lim] of CLAUDE_CONTEXT_LIMITS) {
      if (re.test(model)) { return lim; }
    }
  }
  return DEFAULT_CLAUDE_CONTEXT_LIMIT;
}

/** Compact usage snapshot forwarded to the office. */
export type ClaudeUsagePayload = UsagePayload;

export function extractClaudeUsage(
  usage: unknown,
  model?: string | null,
): UsagePayload | null {
  if (!usage || typeof usage !== 'object') { return null; }
  const u = usage as Record<string, unknown>;
  const input       = nonNeg(u['input_tokens']);
  const output      = nonNeg(u['output_tokens']);
  const cacheRead   = nonNeg(u['cache_read_input_tokens']);
  const cacheCreate = nonNeg(u['cache_creation_input_tokens']);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreate === 0) { return null; }
  const contextTokens = input + cacheRead + cacheCreate;
  const limit = contextLimitForModel(model);
  const rawPct = limit > 0 ? (contextTokens / limit) * 100 : 0;
  return {
    tokens: input + output,
    inputTokens: input,
    outputTokens: output,
    contextTokens,
    contextPct: Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10)),
  };
}

export class ClaudeProviderUsage extends ProviderUsage {
  readonly family = 'claude';
  readonly defaultContextLimit = DEFAULT_CLAUDE_CONTEXT_LIMIT;
  extract(raw: unknown, model?: string | null): UsagePayload | null {
    return extractClaudeUsage(raw, model);
  }
}
