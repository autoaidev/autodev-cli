import { ProviderEvents } from '../base/ProviderEvents';

export class CopilotProviderEvents extends ProviderEvents {
  readonly provider: string;
  constructor(provider = 'copilot-cli') { super(); this.provider = provider; }

  listSupported(): string[] {
    return [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'AgentMessage', 'Notification', 'Stop', 'TurnStart', 'TurnEnd',
      'PermissionRequest', 'SubagentStart',
    ];
  }
}
