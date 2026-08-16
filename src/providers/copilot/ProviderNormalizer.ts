import { ProviderNormalizer } from '../base/ProviderNormalizer';

export class CopilotProviderNormalizer extends ProviderNormalizer {
  readonly provider: string;
  constructor(provider = 'copilot-sdk') { super(); this.provider = provider; }
}
