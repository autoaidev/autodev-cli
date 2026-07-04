// ---------------------------------------------------------------------------
// ProviderRegistry — single point that maps a ProviderId to its IProvider
// strategy (dependency inversion: callers depend on this + IProvider, never on
// a concrete provider). Adding a provider = add a class + one line here, with
// no change to the dispatcher (open/closed).
// ---------------------------------------------------------------------------

import { ProviderId } from '../../providers';
import { IProvider } from './contract';
import {
  ClaudeCliProvider, CopilotCliProvider, OpenCodeCliProvider,
  ClaudeTuiProvider, CopilotSdkProvider, OpenCodeSdkProvider, GrokCliProvider, GrokTuiProvider,
} from './implementations';

export class ProviderRegistry {
  private readonly _providers = new Map<ProviderId, IProvider>();

  constructor(providers: IProvider[]) {
    for (const p of providers) { this._providers.set(p.id, p); }
  }

  /** Resolve a provider by id. Throws on an unknown id (fail loudly). */
  get(id: ProviderId): IProvider {
    const p = this._providers.get(id);
    if (!p) { throw new Error(`No provider registered for id "${id}"`); }
    return p;
  }

  has(id: ProviderId): boolean { return this._providers.has(id); }

  ids(): ProviderId[] { return [...this._providers.keys()]; }
}

/** The default registry wired with every built-in provider. */
export const providerRegistry = new ProviderRegistry([
  new ClaudeCliProvider(),
  new CopilotCliProvider(),
  new OpenCodeCliProvider(),
  new ClaudeTuiProvider(),
  new CopilotSdkProvider(),
  new OpenCodeSdkProvider(),
  new GrokCliProvider(),
  new GrokTuiProvider(),
]);
