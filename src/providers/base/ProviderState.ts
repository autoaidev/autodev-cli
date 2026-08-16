// ---------------------------------------------------------------------------
// ProviderState — busy / activity / teardown for a persistent (sdk/tui)
// provider. CLI providers inherit the idle defaults.
// ---------------------------------------------------------------------------

import type { Logger } from './contract';

export abstract class ProviderState {
  abstract readonly family: string;

  isBusy(_root: string): boolean { return false; }
  lastActivity(_root: string): number { return 0; }
  forceIdle(_root: string): void { /* no-op */ }
  close(_root: string, _log: Logger): void { /* no-op */ }
  closeAll(): void { /* no-op */ }
}
