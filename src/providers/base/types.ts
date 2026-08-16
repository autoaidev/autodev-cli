// ---------------------------------------------------------------------------
// Shared provider-layer types used by every family (claude / grok / opencode /
// copilot / dummy). Kept here so service classes don't re-declare the same
// DTOs and so tests can import one shape.
// ---------------------------------------------------------------------------

/** Normalized transcript message shared across session readers. */
export interface TranscriptMsg {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts?: number;
}

/** Compact usage snapshot forwarded to pixel-office (all ints, pct 0..100). */
export interface UsagePayload {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextPct: number;
}

/** One catalog entry for a provider's supported models. */
export interface ModelInfo {
  id: string;
  label: string;
  contextLimit: number;
}

/** Workspace-scoped session descriptor (newest-first lists). */
export interface SessionRecord {
  id: string;
  name?: string;
  cwd?: string;
  updated: number;
  file?: string;
  msgs?: number;
}

export type { HookEvent } from './ProviderNormalizer';
