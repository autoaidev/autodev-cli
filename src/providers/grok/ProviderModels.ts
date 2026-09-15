import { ProviderModels } from '../base/ProviderModels';
import { fetchLiveModels } from '../base/liveModels';
import { readGrokToken } from './token';
import type { ModelInfo } from '../base/types';

// Static fallback — used whenever the live xAI call can't deliver (no token,
// offline, non-200, timeout). Kept in sync with the friendly labels the app shows.
const GROK_MODELS: ModelInfo[] = [
  { id: 'grok-4', label: 'Grok 4', contextLimit: 256_000 },
  { id: 'grok-code', label: 'Grok Code', contextLimit: 256_000 },
  { id: 'grok-3', label: 'Grok 3', contextLimit: 131_072 },
];

export class GrokProviderModels extends ProviderModels {
  readonly family = 'grok';
  list(): ModelInfo[] { return GROK_MODELS.slice(); }
  override defaultContextLimit(): number { return 256_000; }

  /**
   * Pull grok's REAL models live from xAI's OpenAI-compatible endpoint
   * (GET https://api.x.ai/v1/models, Bearer <grok token>). Ids that match a
   * static entry keep its label/contextLimit; others derive a friendly label
   * and use the entry's reported context_length. Falls back to the static list
   * on any failure; cached briefly per-process. Never logs the token.
   */
  override async listLive(): Promise<ModelInfo[]> {
    return fetchLiveModels({
      family: this.family,
      staticModels: this.list(),
      url: 'https://api.x.ai/v1/models',
      token: readGrokToken(),
      defaultContextLimit: this.defaultContextLimit(),
    });
  }
}
