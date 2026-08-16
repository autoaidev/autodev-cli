import { ProviderState } from '../base/ProviderState';
import type { Logger } from '../base/contract';
import {
  isOpencodeSdkBusy,
  getOpencodeSdkActivity,
  closeOpencodeSdkClient,
  closeAllOpencodeSdkClients,
  forceIdleOpencodeSdk,
} from './sdk';

export class OpencodeCliProviderState extends ProviderState {
  readonly family = 'opencode-cli';
}

export class OpencodeSdkProviderState extends ProviderState {
  readonly family = 'opencode-sdk';
  override isBusy(root: string): boolean { return isOpencodeSdkBusy(root); }
  override lastActivity(_root: string): number { return 0; }
  activity(root: string): string | undefined { return getOpencodeSdkActivity(root); }
  override forceIdle(root: string): void { forceIdleOpencodeSdk(root); }
  override close(root: string, log: Logger): void { closeOpencodeSdkClient(root, log); }
  override closeAll(): void { closeAllOpencodeSdkClients(); }
}
