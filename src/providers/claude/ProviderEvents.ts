import { ProviderEvents } from '../base/ProviderEvents';

export class ClaudeProviderEvents extends ProviderEvents {
  readonly provider = 'claude-cli';

  listSupported(): string[] {
    return [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'AgentMessage', 'Notification', 'Stop', 'StopFailure',
      'PermissionRequest', 'PermissionDenied',
      'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
    ];
  }
}
