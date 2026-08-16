// ---------------------------------------------------------------------------
// ProviderManager — the main controller for one provider id. Composes the
// service classes (events / models / sessions / state / normalizer / usage)
// and implements IProvider so the registry + dispatcher stay unchanged.
// ---------------------------------------------------------------------------

import { ProviderId } from '../../providers';
import { BaseProvider } from './BaseProvider';
import {
  ProviderKind, Logger, DispatchRequest, DispatchOutcome, DispatchContext,
} from './contract';
import { ProviderEvents } from './ProviderEvents';
import { ProviderModels } from './ProviderModels';
import { ProviderSessions } from './ProviderSessions';
import { ProviderState } from './ProviderState';
import { ProviderNormalizer } from './ProviderNormalizer';
import { ProviderUsage } from './ProviderUsage';

export abstract class ProviderManager extends BaseProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly kind: ProviderKind;
  abstract readonly family: string;

  abstract readonly events: ProviderEvents;
  abstract readonly models: ProviderModels;
  abstract readonly sessions: ProviderSessions;
  abstract readonly state: ProviderState;
  abstract readonly normalizer: ProviderNormalizer;
  abstract readonly usage: ProviderUsage;

  override isBusy(root: string): boolean {
    return this.state.isBusy(root);
  }

  override close(root: string, log: Logger): void {
    this.state.close(root, log);
  }

  override async resolveSession(root: string, log: Logger): Promise<string | undefined> {
    return this.sessions.resolveLatest(root, log);
  }

  abstract dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome>;
}
