import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { teeCommand, withExitFile } from '../../core/commandHelpers';
import { ClaudeProviderEvents } from './ProviderEvents';
import { ClaudeProviderModels } from './ProviderModels';
import { ClaudeProviderSessions } from './ProviderSessions';
import { ClaudeCliProviderState, ClaudeTuiProviderState } from './ProviderState';
import { ClaudeProviderNormalizer } from './ProviderNormalizer';
import { ClaudeProviderUsage } from './ProviderUsage';
import { buildClaudeCliCommand, probeClaudeSession } from './cli';
import { sendClaudeTuiPrompt } from './tui';

export class ClaudeCliProvider extends ProviderManager {
  readonly id: ProviderId = 'claude-cli';
  readonly label = 'Claude CLI';
  readonly kind: ProviderKind = 'cli';
  readonly family = 'claude';
  readonly events = new ClaudeProviderEvents();
  readonly models = new ClaudeProviderModels();
  readonly sessions = new ClaudeProviderSessions();
  readonly state = new ClaudeCliProviderState();
  readonly normalizer = new ClaudeProviderNormalizer('claude-cli');
  readonly usage = new ClaudeProviderUsage();

  override resolveSession(root: string, log: Logger) { return probeClaudeSession(root, log); }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    let cmd = buildClaudeCliCommand(
      req.agentProfileFile, req.messageFile, req.resolvedSessionId,
      req.includeProfile, req.settings.claudeModel || undefined,
    );
    cmd = teeCommand(cmd, req.stdoutFile);
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

export class ClaudeTuiProvider extends ProviderManager {
  readonly id: ProviderId = 'claude-tui';
  readonly label = 'Claude TUI';
  readonly kind: ProviderKind = 'tui';
  readonly family = 'claude';
  readonly events = new ClaudeProviderEvents();
  readonly models = new ClaudeProviderModels();
  readonly sessions = new ClaudeProviderSessions();
  readonly state = new ClaudeTuiProviderState();
  readonly normalizer = new ClaudeProviderNormalizer('claude-tui');
  readonly usage = new ClaudeProviderUsage();

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    sendClaudeTuiPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, req.settings.claudeModel || undefined, ctx.showOutput);
    return {};
  }
}
