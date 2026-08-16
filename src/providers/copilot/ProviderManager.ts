import * as fs from 'fs';
import * as path from 'path';
import { copilotMcpConfigPath } from '../../configManager';
import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { teeCommand, withExitFile, wrapWithSyntheticHooks } from '../../core/commandHelpers';
import { CopilotProviderEvents } from './ProviderEvents';
import { CopilotProviderModels } from './ProviderModels';
import { CopilotProviderSessions } from './ProviderSessions';
import { CopilotCliProviderState, CopilotSdkProviderState } from './ProviderState';
import { CopilotProviderNormalizer } from './ProviderNormalizer';
import { CopilotProviderUsage } from './ProviderUsage';
import { buildCopilotCliCommand, probeCopilotSession } from './cli';
import { sendCopilotSdkPrompt, setCopilotSettingsToken } from './sdk';

export class CopilotCliProvider extends ProviderManager {
  readonly id: ProviderId = 'copilot-cli';
  readonly label = 'Copilot CLI';
  readonly kind: ProviderKind = 'cli';
  readonly family = 'copilot';
  readonly events = new CopilotProviderEvents('copilot-cli');
  readonly models = new CopilotProviderModels();
  readonly sessions = new CopilotProviderSessions();
  readonly state = new CopilotCliProviderState();
  readonly normalizer = new CopilotProviderNormalizer('copilot-cli');
  readonly usage = new CopilotProviderUsage();

  override resolveSession(root: string, log: Logger) { return probeCopilotSession(root, log); }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    if (req.settings.copilotGithubToken) {
      process.env['COPILOT_GITHUB_TOKEN'] = req.settings.copilotGithubToken;
      if (! process.env['GH_TOKEN']) { process.env['GH_TOKEN'] = req.settings.copilotGithubToken; }
    }
    const mcpCfg = copilotMcpConfigPath(req.root);
    const mcpCfgFile = fs.existsSync(mcpCfg) ? mcpCfg : undefined;

    let cmd = buildCopilotCliCommand(req.combinedFile, req.resolvedSessionId, req.settings.copilotModel || undefined, req.settings.sessionName || undefined, mcpCfgFile);
    cmd = teeCommand(cmd, req.stdoutFile);
    if (req.settings.hooksEnabled) {
      cmd = wrapWithSyntheticHooks(cmd, 'copilot-cli', req.root, path.basename(req.root));
    }
    return { command: withExitFile(cmd, req.exitFile) };
  }
}

export class CopilotSdkProvider extends ProviderManager {
  readonly id: ProviderId = 'copilot-sdk';
  readonly label = 'Copilot SDK';
  readonly kind: ProviderKind = 'sdk';
  readonly family = 'copilot';
  readonly events = new CopilotProviderEvents('copilot-sdk');
  readonly models = new CopilotProviderModels();
  readonly sessions = new CopilotProviderSessions();
  readonly state = new CopilotSdkProviderState();
  readonly normalizer = new CopilotProviderNormalizer('copilot-sdk');
  readonly usage = new CopilotProviderUsage();

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    setCopilotSettingsToken(req.settings.copilotGithubToken || undefined);
    sendCopilotSdkPrompt(req.root, req.combinedFile, req.resolvedSessionId,
      req.stdoutFile, req.exitFile, ctx.log, ctx.showOutput);
    return {};
  }
}
