// ---------------------------------------------------------------------------
// Concrete provider strategies. Each class owns ONLY its provider-specific
// dispatch shape; the shared command wrapping (tee → synthetic hooks →
// exit-file) is reused from the dispatcher helpers (DRY). Behaviour mirrors the
// pre-refactor switch in dispatcher.ts exactly.
// ---------------------------------------------------------------------------

import * as path from 'path';
import { ProviderId } from '../../providers';
import { BaseProvider } from './BaseProvider';
import {
  ProviderKind, Logger, DispatchRequest, DispatchOutcome, DispatchContext,
} from './contract';
import {
  teeCommand, withExitFile, wrapWithSyntheticHooks,
} from '../commandHelpers';

import { buildClaudeCliCommand, probeClaudeSession } from '../../providers/claudeCliProvider';
import { buildCopilotCliCommand, probeCopilotSession } from '../../providers/copilotCliProvider';
import { buildOpenCodeCliCommand, getLatestOpenCodeSessionId } from '../../providers/opencodeCliProvider';
import { sendClaudeTuiPrompt, isClaudeTuiBusy, closeClaudeTuiClient } from '../../providers/claudeTuiProvider';
import { sendCopilotSdkPrompt, isCopilotSdkBusy, closeCopilotSdkSession, setCopilotSettingsToken } from '../../providers/copilotSdkProvider';
import { sendOpencodeSdkPrompt, isOpencodeSdkBusy, closeOpencodeSdkClient } from '../../providers/opencodeSdkProvider';
import { sendGrokTuiPrompt } from '../../providers/grokTuiProvider';
import { getSessionClearedAt } from '../../sessionState';

// --- CLI providers --------------------------------------------------------

export class ClaudeCliProvider extends BaseProvider {
  readonly id: ProviderId = 'claude-cli';
  readonly label = 'Claude CLI';
  readonly kind: ProviderKind = 'cli';
  resolveSession(root: string, log: Logger) { return probeClaudeSession(root, log); }
  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    let cmd = buildClaudeCliCommand(
      req.agentProfileFile, req.messageFile, req.resolvedSessionId,
      req.includeProfile, req.settings.claudeModel || undefined,
    );
    cmd = teeCommand(cmd, req.stdoutFile);
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

export class CopilotCliProvider extends BaseProvider {
  readonly id: ProviderId = 'copilot-cli';
  readonly label = 'Copilot CLI';
  readonly kind: ProviderKind = 'cli';
  resolveSession(root: string, log: Logger) { return probeCopilotSession(root, log); }
  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    // Authenticate the copilot CLI with the agent's configured token via env
    // (COPILOT_GITHUB_TOKEN) — kept out of the command string so it never lands
    // in logs. The copilot child inherits process.env.
    if (req.settings.copilotGithubToken) {
      process.env['COPILOT_GITHUB_TOKEN'] = req.settings.copilotGithubToken;
      if (! process.env['GH_TOKEN']) { process.env['GH_TOKEN'] = req.settings.copilotGithubToken; }
    }
    let cmd = buildCopilotCliCommand(req.combinedFile, req.resolvedSessionId, req.settings.copilotModel || undefined, req.settings.sessionName || undefined);
    cmd = teeCommand(cmd, req.stdoutFile);
    if (req.settings.hooksEnabled) {
      cmd = wrapWithSyntheticHooks(cmd, 'copilot-cli', req.root, path.basename(req.root));
    }
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

export class OpenCodeCliProvider extends BaseProvider {
  readonly id: ProviderId = 'opencode-cli';
  readonly label = 'OpenCode CLI';
  readonly kind: ProviderKind = 'cli';
  resolveSession(root: string, log: Logger) {
    return getLatestOpenCodeSessionId(root, log, getSessionClearedAt(root, 'opencode-cli'));
  }
  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    let cmd = buildOpenCodeCliCommand(req.combinedFile, req.resolvedSessionId, req.settings.opencodeModel || undefined, req.settings.sessionName || undefined);
    cmd = teeCommand(cmd, req.stdoutFile);
    if (req.settings.hooksEnabled) {
      cmd = wrapWithSyntheticHooks(cmd, 'opencode-cli', req.root, path.basename(req.root));
    }
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

// --- In-process providers (sdk / tui) -------------------------------------

export class ClaudeTuiProvider extends BaseProvider {
  readonly id: ProviderId = 'claude-tui';
  readonly label = 'Claude TUI';
  readonly kind: ProviderKind = 'tui';
  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome> {
    sendClaudeTuiPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, req.settings.claudeModel || undefined, ctx.showOutput);
    return {};
  }
  isBusy(root: string) { return isClaudeTuiBusy(root); }
  close(root: string, log: Logger) { closeClaudeTuiClient(root, log); }
}

export class CopilotSdkProvider extends BaseProvider {
  readonly id: ProviderId = 'copilot-sdk';
  readonly label = 'Copilot SDK';
  readonly kind: ProviderKind = 'sdk';
  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome> {
    setCopilotSettingsToken(req.settings.copilotGithubToken || undefined);
    sendCopilotSdkPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, ctx.showOutput);
    return {};
  }
  isBusy(root: string) { return isCopilotSdkBusy(root); }
  close(root: string, log: Logger) { closeCopilotSdkSession(root, log); }
}

export class OpenCodeSdkProvider extends BaseProvider {
  readonly id: ProviderId = 'opencode-sdk';
  readonly label = 'OpenCode SDK';
  readonly kind: ProviderKind = 'sdk';
  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome> {
    sendOpencodeSdkPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, req.settings.opencodeModel || undefined, ctx.showOutput);
    return {};
  }
  isBusy(root: string) { return isOpencodeSdkBusy(root); }
  close(root: string, log: Logger) { closeOpencodeSdkClient(root, log); }
}

export class GrokTuiProvider extends BaseProvider {
  readonly id: ProviderId = 'grok-tui';
  readonly label = 'Grok TUI';
  readonly kind: ProviderKind = 'tui';
  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome> {
    sendGrokTuiPrompt(req.root, req.combinedFile, req.stdoutFile, req.exitFile,
      ctx.log, req.settings.grokModel || undefined, ctx.showOutput);
    return {};
  }
}
