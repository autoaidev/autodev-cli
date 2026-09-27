import * as path from 'path';
import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { teeCommand, withExitFile, wrapWithSyntheticHooks } from '../../core/commandHelpers';
import { getSessionClearedAt } from '../../sessionState';
import { OpencodeProviderEvents } from './ProviderEvents';
import { OpencodeProviderModels } from './ProviderModels';
import { OpencodeProviderSessions } from './ProviderSessions';
import { OpencodeCliProviderState, OpencodeSdkProviderState } from './ProviderState';
import { OpencodeProviderNormalizer } from './ProviderNormalizer';
import { OpencodeProviderUsage } from './ProviderUsage';
import { buildOpenCodeCliCommand, getLatestOpenCodeSessionId } from './cli';
import { sendOpencodeSdkPrompt, opencodeCliPersistentEnabled } from './sdk';

// Test seam: the persistent-sibling sender opencode-cli routes to when persistent.
// Swappable so a unit test can assert the routing without starting a server.
type OpencodeSdkSender = typeof sendOpencodeSdkPrompt;
let _opencodeCliPersistentSender: OpencodeSdkSender = sendOpencodeSdkPrompt;
export function __setOpencodeCliSenderForTest(fn: OpencodeSdkSender | null): void {
  _opencodeCliPersistentSender = fn ?? sendOpencodeSdkPrompt;
}

export class OpenCodeCliProvider extends ProviderManager {
  readonly id: ProviderId = 'opencode-cli';
  readonly label = 'OpenCode CLI';
  readonly kind: ProviderKind = 'cli';
  readonly family = 'opencode';
  readonly events = new OpencodeProviderEvents('opencode-cli');
  readonly models = new OpencodeProviderModels();
  readonly sessions = new OpencodeProviderSessions();
  readonly state = new OpencodeCliProviderState();
  readonly normalizer = new OpencodeProviderNormalizer('opencode-cli');
  readonly usage = new OpencodeProviderUsage();

  override resolveSession(root: string, log: Logger) {
    return getLatestOpenCodeSessionId(root, log, getSessionClearedAt(root, 'opencode-cli'));
  }

  async dispatch(req: DispatchRequest, ctx?: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    // PERSISTENT path (Phase 2): reuse the opencode-sdk in-process server +
    // session across turns — one long-lived server per workspace, RESUMING the
    // same session id (resolvedSessionId) so opencode never mints a new session
    // per turn (memory opencode-session-explosion). Falls back to the per-turn
    // command below when the gate is off or the SDK is unavailable.
    if (opencodeCliPersistentEnabled()) {
      _opencodeCliPersistentSender(
        req.root, req.combinedFile, req.resolvedSessionId,
        req.stdoutFile, req.exitFile, ctx?.log ?? (() => {}),
        req.settings.opencodeModel || undefined, ctx?.showOutput,
      );
      return {};
    }

    let cmd = buildOpenCodeCliCommand(req.combinedFile, req.resolvedSessionId, req.settings.opencodeModel || undefined, req.settings.sessionName || undefined);
    cmd = teeCommand(cmd, req.stdoutFile);
    if (req.settings.hooksEnabled) {
      cmd = wrapWithSyntheticHooks(cmd, 'opencode-cli', req.root, path.basename(req.root));
    }
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

export class OpenCodeSdkProvider extends ProviderManager {
  readonly id: ProviderId = 'opencode-sdk';
  readonly label = 'OpenCode SDK';
  readonly kind: ProviderKind = 'sdk';
  readonly family = 'opencode';
  readonly events = new OpencodeProviderEvents('opencode-sdk');
  readonly models = new OpencodeProviderModels();
  readonly sessions = new OpencodeProviderSessions();
  readonly state = new OpencodeSdkProviderState();
  readonly normalizer = new OpencodeProviderNormalizer('opencode-sdk');
  readonly usage = new OpencodeProviderUsage();

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    sendOpencodeSdkPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, req.settings.opencodeModel || undefined, ctx.showOutput);
    return {};
  }
}
