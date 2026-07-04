// ---------------------------------------------------------------------------
// AI provider definitions — CLI-only providers
// ---------------------------------------------------------------------------

export type ProviderId = 'claude-cli' | 'claude-tui' | 'copilot-cli' | 'copilot-sdk' | 'opencode-cli' | 'opencode-sdk' | 'grok-cli' | 'grok-tui';

export interface ProviderConfig {
  label: string;
  /** VS Code extension ID required for this provider (empty string for CLI providers). */
  extensionId: string;
  /** True for providers that run in a VS Code terminal instead of the chat UI. */
  isCli?: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  'claude-cli': {
    label: 'Claude CLI',
    extensionId: '',
    isCli: true,
  },
  'claude-tui': {
    label: 'Claude TUI',
    extensionId: '',
    isCli: true,
  },
  'copilot-cli': {
    label: 'Copilot CLI',
    extensionId: '',
    isCli: true,
  },
  'copilot-sdk': {
    label: 'Copilot SDK',
    extensionId: '',
    isCli: true,
  },
  'opencode-cli': {
    label: 'OpenCode CLI',
    extensionId: '',
    isCli: true,
  },
  'opencode-sdk': {
    label: 'OpenCode SDK',
    extensionId: '',
    isCli: true,
  },
  'grok-cli': {
    label: 'Grok CLI',
    extensionId: '',
    isCli: true,
  },
  'grok-tui': {
    label: 'Grok TUI',
    extensionId: '',
    isCli: true,
  },
};
