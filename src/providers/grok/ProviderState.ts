import { ProviderState } from '../base/ProviderState';
import type { Logger } from '../base/contract';
import {
  isGrokTuiBusy,
  getGrokTuiLastActivity,
  forceIdleGrokTui,
  closeGrokTuiSession,
  closeAllGrokTuiSessions,
} from './tui';

export class GrokProviderState extends ProviderState {
  readonly family = 'grok';
  override isBusy(root: string): boolean { return isGrokTuiBusy(root); }
  override lastActivity(root: string): number { return getGrokTuiLastActivity(root); }
  override forceIdle(root: string): void { forceIdleGrokTui(root); }
  override close(root: string, log: Logger): void { closeGrokTuiSession(root, log); }
  override closeAll(): void { closeAllGrokTuiSessions(); }
}
