import { ProviderState } from '../base/ProviderState';
import type { Logger } from '../base/contract';
import { isCopilotSdkBusy, closeCopilotSdkSession, closeAllCopilotSdkSessions } from './sdk';

export class CopilotCliProviderState extends ProviderState {
  readonly family = 'copilot-cli';
}

export class CopilotSdkProviderState extends ProviderState {
  readonly family = 'copilot-sdk';
  override isBusy(root: string): boolean { return isCopilotSdkBusy(root); }
  override close(root: string, log: Logger): void { closeCopilotSdkSession(root, log); }
  override closeAll(): void { closeAllCopilotSdkSessions(); }
}
