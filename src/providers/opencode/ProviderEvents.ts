import { ProviderEvents } from '../base/ProviderEvents';

export class OpencodeProviderEvents extends ProviderEvents {
  readonly provider: string;
  constructor(provider = 'opencode-sdk') { super(); this.provider = provider; }

  listSupported(): string[] {
    return [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'AgentMessage', 'Notification', 'Stop', 'StopFailure',
      'PermissionReplied', 'PostCompact', 'TaskCreated',
    ];
  }
}
