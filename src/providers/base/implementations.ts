// ---------------------------------------------------------------------------
// Concrete provider strategies. Each class lives in its family folder; this
// module re-exports them so the registry (and existing imports) stay stable.
// ---------------------------------------------------------------------------

export { ClaudeCliProvider, ClaudeTuiProvider } from '../claude/ProviderManager';
export { CopilotCliProvider, CopilotSdkProvider } from '../copilot/ProviderManager';
export { OpenCodeCliProvider, OpenCodeSdkProvider } from '../opencode/ProviderManager';
export { GrokCliProvider, GrokTuiProvider } from '../grok/ProviderManager';
export { DummyProvider, dummyProvider } from '../dummy/ProviderManager';
