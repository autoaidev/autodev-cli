import { ProviderModels } from '../base/ProviderModels';
import type { ModelInfo } from '../base/types';

const COPILOT_MODELS: ModelInfo[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', contextLimit: 128_000 },
  { id: 'gpt-5', label: 'GPT-5', contextLimit: 128_000 },
  { id: 'gpt-4o', label: 'GPT-4o', contextLimit: 128_000 },
  { id: 'claude-sonnet-4.6', label: 'Sonnet 4.6', contextLimit: 200_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextLimit: 1_000_000 },
];

export class CopilotProviderModels extends ProviderModels {
  readonly family = 'copilot';
  list(): ModelInfo[] { return COPILOT_MODELS.slice(); }
  override defaultContextLimit(): number { return 128_000; }
}
