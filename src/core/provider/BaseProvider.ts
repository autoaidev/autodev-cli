// ---------------------------------------------------------------------------
// Abstract base — provides the sane defaults shared by every provider so each
// concrete class only states what is genuinely different (Liskov + DRY). CLI
// providers inherit the no-op isBusy/close; only persistent sdk/tui providers
// override them.
// ---------------------------------------------------------------------------

import { ProviderId } from '../../providers';
import {
  IProvider, ProviderKind, Logger, DispatchRequest, DispatchOutcome, DispatchContext,
} from './contract';

export abstract class BaseProvider implements IProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly kind: ProviderKind;

  /** Default: no session to resume. CLI providers that probe override this. */
  async resolveSession(_root: string, _log: Logger): Promise<string | undefined> {
    return undefined;
  }

  abstract dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome>;

  /** Default: stateless, never "busy" between dispatches. */
  isBusy(_root: string): boolean {
    return false;
  }

  /** Default: nothing persistent to tear down. */
  close(_root: string, _log: Logger): void {
    /* no-op */
  }
}
