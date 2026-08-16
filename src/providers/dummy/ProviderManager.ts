import * as fs from 'fs';
import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { DummyProviderEvents } from './ProviderEvents';
import { DummyProviderModels } from './ProviderModels';
import { DummyProviderSessions } from './ProviderSessions';
import { DummyProviderState } from './ProviderState';
import { DummyProviderNormalizer } from './ProviderNormalizer';
import { DummyProviderUsage } from './ProviderUsage';
import { extractUserText, parseDummyCommand } from './commands';
import { generateDummyTurn } from './traces';
import { DummyOfficeBridge, DummyOfficeConnect } from './office';

export class DummyProvider extends ProviderManager {
  readonly id: ProviderId = 'dummy';
  readonly label = 'Dummy Agent';
  readonly kind: ProviderKind = 'sdk';
  readonly family = 'dummy';
  readonly events = new DummyProviderEvents();
  readonly models = new DummyProviderModels();
  readonly sessions = new DummyProviderSessions();
  readonly state = new DummyProviderState();
  readonly normalizer = new DummyProviderNormalizer();
  readonly usage = new DummyProviderUsage();

  /** Optional office WS bridge — tests (and office runs) can attach one. */
  readonly office = new DummyOfficeBridge();

  connectOffice(opts: DummyOfficeConnect): void {
    this.office.connect(opts);
  }

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    ctx.showOutput?.();
    this.state.markBusy(req.root);
    try {
      fs.writeFileSync(req.stdoutFile, '', 'utf8');
      fs.writeFileSync(req.exitFile, '', 'utf8');
    } catch { /* ignore */ }

    let prompt = '';
    try { prompt = fs.readFileSync(req.combinedFile, 'utf8'); }
    catch {
      try { prompt = fs.readFileSync(req.messageFile, 'utf8'); } catch { prompt = ''; }
    }

    const userText = extractUserText(prompt);
    const cmd = parseDummyCommand(userText);
    ctx.log(`Dummy: handling command "${cmd.kind}" (${userText.length} chars)`);

    let sessionId = req.resolvedSessionId;
    if (!sessionId) {
      sessionId = (await this.sessions.resolveLatest(req.root)) ?? this.sessions.create(req.root, req.settings.sessionName || 'dummy-session').id;
    }

    const turn = generateDummyTurn(req.root, cmd, sessionId);
    for (const ev of turn.events) {
      this.events.append(req.root, ev);
      if (this.office.isConnected) { this.office.sendHookEvent(ev); }
    }
    this.sessions.appendMessages(req.root, sessionId, turn.transcript);

    try { fs.writeFileSync(req.stdoutFile, turn.stdout, 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(req.exitFile, '0\n', 'utf8'); } catch { /* ignore */ }
    this.state.markIdle(req.root);
    ctx.log(`Dummy: turn complete (${turn.events.length} hook events)`);
    return {};
  }
}

/** Singleton used by the default registry — tests can reach `.office`. */
export const dummyProvider = new DummyProvider();
