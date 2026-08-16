import { ProviderModels } from '../base/ProviderModels';
import type { ModelInfo } from '../base/types';

const GROK_MODELS: ModelInfo[] = [
  { id: 'grok-4', label: 'Grok 4', contextLimit: 256_000 },
  { id: 'grok-code', label: 'Grok Code', contextLimit: 256_000 },
  { id: 'grok-3', label: 'Grok 3', contextLimit: 131_072 },
];

export class GrokProviderModels extends ProviderModels {
  readonly family = 'grok';
  list(): ModelInfo[] { return GROK_MODELS.slice(); }
  override defaultContextLimit(): number { return 256_000; }
}
