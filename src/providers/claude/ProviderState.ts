import { ProviderState } from '../base/ProviderState';
import type { Logger } from '../base/contract';
import {
  isClaudeTuiBusy,
  getClaudeTuiLastActivity,
  forceIdleClaudeTui,
  closeClaudeTuiClient,
  closeAllClaudeTuiClients,
} from './tui';

export class ClaudeCliProviderState extends ProviderState {
  readonly family = 'claude-cli';
}

export class ClaudeTuiProviderState extends ProviderState {
  readonly family = 'claude-tui';
  override isBusy(root: string): boolean { return isClaudeTuiBusy(root); }
  override lastActivity(root: string): number { return getClaudeTuiLastActivity(root); }
  override forceIdle(root: string): void { forceIdleClaudeTui(root); }
  override close(root: string, log: Logger): void { closeClaudeTuiClient(root, log); }
  override closeAll(): void { closeAllClaudeTuiClients(); }
}
