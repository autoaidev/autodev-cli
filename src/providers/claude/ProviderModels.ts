import { ProviderModels } from '../base/ProviderModels';
import type { ModelInfo } from '../base/types';

export const DEFAULT_CLAUDE_CONTEXT_LIMIT = 200_000;

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', contextLimit: 200_000 },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', contextLimit: 200_000 },
  { id: 'claude-opus-4', label: 'Opus 4', contextLimit: 200_000 },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', contextLimit: 200_000 },
  { id: 'claude-sonnet-4', label: 'Sonnet 4', contextLimit: 200_000 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', contextLimit: 200_000 },
  { id: 'opus', label: 'Opus', contextLimit: 200_000 },
  { id: 'sonnet', label: 'Sonnet', contextLimit: 200_000 },
  { id: 'haiku', label: 'Haiku', contextLimit: 200_000 },
];

export class ClaudeProviderModels extends ProviderModels {
  readonly family = 'claude';
  list(): ModelInfo[] { return CLAUDE_MODELS.slice(); }
  override defaultContextLimit(): number { return DEFAULT_CLAUDE_CONTEXT_LIMIT; }
}
