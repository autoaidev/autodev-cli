// ---------------------------------------------------------------------------
// claudeUsage — derive a running token / context-window snapshot from a Claude
// transcript assistant message's `message.usage` block.
//
// Why this exists
// ---------------
// Claude Code fires NO hook carrying token counts — usage lives only in the
// session transcript (`~/.claude/projects/…/<id>.jsonl`). The mcp-operate
// bridge already tails that transcript for assistant narration; this helper
// turns each message's `usage` block into the compact, provider-agnostic
// snapshot the pixel-office progress bar renders (context% + tokens), matching
// the shape the office already consumes for opencode / copilot.
//
// Contract forwarded to the server (attached to the narration `hook_event`
// frame under `data.usage`):
//   { tokens, inputTokens, outputTokens, contextTokens, contextPct }
// where
//   tokens        = input_tokens + output_tokens        (this turn's total —
//                   same per-turn semantics as opencode's step token total)
//   contextTokens = input_tokens + cache_read_input_tokens
//                                + cache_creation_input_tokens (window occupancy)
//   contextPct    = contextTokens / limit * 100, clamped 0..100 (1 decimal)
//
// NEVER logs token values or transcript content.
// ---------------------------------------------------------------------------

/**
 * Per-model context-window limits (tokens). Every current Claude model —
 * Opus / Sonnet / Haiku — exposes a 200k-token context window, and unknown
 * Claude models default to the same. Extend this table if a model ever ships a
 * different window (e.g. a 1M-token beta).
 */
const CLAUDE_CONTEXT_LIMITS: Array<[RegExp, number]> = [
  [/opus/i, 200_000],
  [/sonnet/i, 200_000],
  [/haiku/i, 200_000],
];

/** Fallback window for an unknown / absent Claude model id. */
export const DEFAULT_CLAUDE_CONTEXT_LIMIT = 200_000;

/** Resolve the context-window limit (tokens) for a Claude model id. */
export function contextLimitForModel(model?: string | null): number {
  if (model) {
    for (const [re, lim] of CLAUDE_CONTEXT_LIMITS) {
      if (re.test(model)) { return lim; }
    }
  }
  return DEFAULT_CLAUDE_CONTEXT_LIMIT;
}

/** Compact usage snapshot forwarded to the office (all fields non-negative ints, pct 0..100). */
export interface ClaudeUsagePayload {
  /** input + output tokens for this turn (matches opencode's per-step total). */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** input + cache_read + cache_creation — the live context-window occupancy. */
  contextTokens: number;
  /** contextTokens / limit, 0..100, clamped, one decimal place. */
  contextPct: number;
}

/** Coerce an unknown to a finite, non-negative number, else 0. */
function nonNeg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Build a {@link ClaudeUsagePayload} from a Claude message `usage` block.
 *
 * Guards every field read — transcripts vary and `usage` may be absent or
 * partial; returns null when the block carries no usable token signal so the
 * caller can fall back to the last message that DID have usage.
 *
 * @param usage the raw `message.usage` object (any shape; guarded)
 * @param model the raw `message.model` id, used only to pick the context limit
 */
export function extractClaudeUsage(
  usage: unknown,
  model?: string | null,
): ClaudeUsagePayload | null {
  if (!usage || typeof usage !== 'object') { return null; }
  const u = usage as Record<string, unknown>;

  const input       = nonNeg(u['input_tokens']);
  const output      = nonNeg(u['output_tokens']);
  const cacheRead   = nonNeg(u['cache_read_input_tokens']);
  const cacheCreate = nonNeg(u['cache_creation_input_tokens']);

  // No usable signal → treat as absent (caller keeps the last known usage).
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreate === 0) { return null; }

  const contextTokens = input + cacheRead + cacheCreate;
  const limit = contextLimitForModel(model);
  const rawPct = limit > 0 ? (contextTokens / limit) * 100 : 0;
  const contextPct = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));

  return {
    tokens: input + output,
    inputTokens: input,
    outputTokens: output,
    contextTokens,
    contextPct,
  };
}
