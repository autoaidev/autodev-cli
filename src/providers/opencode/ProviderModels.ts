import { ProviderModels } from '../base/ProviderModels';
import type { ModelInfo } from '../base/types';

const OPENCODE_MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4-5', label: 'Sonnet 4.5', contextLimit: 200_000 },
  { id: 'openai/gpt-4o', label: 'gpt-4o', contextLimit: 128_000 },
  { id: 'kimi/k2', label: 'kimi-k2', contextLimit: 128_000 },
  { id: 'opencode-auto', label: 'opencode-auto', contextLimit: 128_000 },
];

export class OpencodeProviderModels extends ProviderModels {
  readonly family = 'opencode';
  list(): ModelInfo[] { return OPENCODE_MODELS.slice(); }
  override defaultContextLimit(): number { return 128_000; }
}
