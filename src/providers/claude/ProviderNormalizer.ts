import { ProviderNormalizer } from '../base/ProviderNormalizer';

export class ClaudeProviderNormalizer extends ProviderNormalizer {
  readonly provider: string;
  constructor(provider = 'claude-cli') { super(); this.provider = provider; }
}
