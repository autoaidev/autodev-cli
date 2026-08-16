import { ProviderNormalizer } from '../base/ProviderNormalizer';

export class GrokProviderNormalizer extends ProviderNormalizer {
  readonly provider: string;
  constructor(provider = 'grok-tui') { super(); this.provider = provider; }
}
