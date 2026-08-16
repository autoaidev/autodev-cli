import { ProviderEvents } from '../base/ProviderEvents';

export class GrokProviderEvents extends ProviderEvents {
  readonly provider: string;
  constructor(provider = 'grok-tui') { super(); this.provider = provider; }

  listSupported(): string[] {
    return [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'Notification', 'Stop', 'StopFailure',
    ];
  }
}
