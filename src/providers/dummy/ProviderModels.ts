import { ProviderModels } from '../base/ProviderModels';
import type { ModelInfo } from '../base/types';

const DUMMY_MODELS: ModelInfo[] = [
  { id: 'dummy-fast', label: 'Dummy Fast', contextLimit: 128_000 },
  { id: 'dummy-smart', label: 'Dummy Smart', contextLimit: 200_000 },
];

export class DummyProviderModels extends ProviderModels {
  readonly family = 'dummy';
  list(): ModelInfo[] { return DUMMY_MODELS.slice(); }
  override defaultContextLimit(): number { return 128_000; }
}
