import { ProviderEvents } from '../base/ProviderEvents';

export class DummyProviderEvents extends ProviderEvents {
  readonly provider = 'dummy';

  listSupported(): string[] {
    return [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'AgentMessage', 'Notification', 'Stop', 'TaskCreated',
    ];
  }
}
