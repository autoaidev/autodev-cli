import { ProviderNormalizer } from '../base/ProviderNormalizer';

export class OpencodeProviderNormalizer extends ProviderNormalizer {
  readonly provider: string;
  constructor(provider = 'opencode-sdk') { super(); this.provider = provider; }
}
