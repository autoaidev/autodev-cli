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

/**
 * Sum the token usage of every assistant message in a slice of Claude session
 * transcript lines (newline-split JSONL). The claude-cli `autodev start` path
 * fires no token-bearing hook — usage lives only in ~/.claude/projects/…/<id>.jsonl
 * — so the loop tails that transcript and attaches the result to forwarded hook
 * frames. The office sums each CHANGED snapshot as one per-turn increment, so a
 * slice spanning several assistant messages (a tool-heavy turn between two 10s
 * ticks) must contribute ALL their input/output, not just the last message's.
 *
 * `input`/`output` are summed (per-message input_tokens is the non-cached input,
 * so the sum is billable non-cache throughput); `contextTokens`/`contextPct`
 * track the LATEST message (a running window gauge, not summed). Returns null
 * when the slice carried no assistant usage, so the caller leaves its cached
 * snapshot intact rather than emitting a spurious zero-token change.
 */
export function sumTranscriptUsage(
  lines: Iterable<string>,
): { usage: UsagePayload; model?: string } | null {
  let inSum = 0, outSum = 0;
  let ctx: number | undefined, pct: number | undefined, model: string | undefined;
  let saw = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { continue; }
    let d: { type?: string; message?: { usage?: unknown; model?: unknown } };
    try { d = JSON.parse(t); } catch { continue; }
    if (d.type !== 'assistant' || !d.message || typeof d.message !== 'object') { continue; }
    const m = typeof d.message.model === 'string' ? d.message.model : undefined;
    const u = extractClaudeUsage(d.message.usage, m);
    if (!u) { continue; }
    saw = true;
    inSum += u.inputTokens;
    outSum += u.outputTokens;
    ctx = u.contextTokens;
    pct = u.contextPct;
    if (m) { model = m; }
  }
  if (!saw) { return null; }
  return {
    usage: { tokens: inSum + outSum, inputTokens: inSum, outputTokens: outSum, contextTokens: ctx ?? 0, contextPct: pct ?? 0 },
    model,
  };
}
