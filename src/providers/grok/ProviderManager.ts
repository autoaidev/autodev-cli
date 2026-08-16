import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { getSessionId } from '../../sessionState';
import { GrokProviderEvents } from './ProviderEvents';
import { GrokProviderModels } from './ProviderModels';
import { GrokProviderSessions } from './ProviderSessions';
import { GrokProviderState } from './ProviderState';
import { GrokProviderNormalizer } from './ProviderNormalizer';
import { GrokProviderUsage } from './ProviderUsage';
import { sendGrokCliPrompt, sendGrokTuiPrompt } from './tui';

export class GrokCliProvider extends ProviderManager {
  readonly id: ProviderId = 'grok-cli';
  readonly label = 'Grok CLI';
  readonly kind: ProviderKind = 'cli';
  readonly family = 'grok';
  readonly events = new GrokProviderEvents('grok-cli');
  readonly models = new GrokProviderModels();
  readonly sessions = new GrokProviderSessions();
  readonly state = new GrokProviderState();
  readonly normalizer = new GrokProviderNormalizer('grok-cli');
  readonly usage = new GrokProviderUsage();

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    sendGrokCliPrompt(req.root, req.combinedFile, req.stdoutFile, req.exitFile,
      ctx.log, req.settings.grokModel || undefined, ctx.showOutput);
    return {};
  }
}

export class GrokTuiProvider extends ProviderManager {
  readonly id: ProviderId = 'grok-tui';
  readonly label = 'Grok TUI';
  readonly kind: ProviderKind = 'tui';
  readonly family = 'grok';
  readonly events = new GrokProviderEvents('grok-tui');
  readonly models = new GrokProviderModels();
  readonly sessions = new GrokProviderSessions();
  readonly state = new GrokProviderState();
  readonly normalizer = new GrokProviderNormalizer('grok-tui');
  readonly usage = new GrokProviderUsage();

  override resolveSession(root: string) { return Promise.resolve(getSessionId(root, 'grok-tui')); }

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    sendGrokTuiPrompt(req.root, req.combinedFile, req.resolvedSessionId, req.stdoutFile, req.exitFile,
      ctx.log, req.settings.grokModel || undefined, ctx.showOutput);
    return {};
  }
}
