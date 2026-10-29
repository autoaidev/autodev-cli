import { ProviderId } from '../../providers';
import { ProviderKind, Logger, DispatchRequest, DispatchOutcome } from '../base/contract';
import { ProviderManager } from '../base/ProviderManager';
import { getSessionId } from '../../sessionState';
import { getGrokLatestSessionId } from './sessions';
import { GrokProviderEvents } from './ProviderEvents';
import { GrokProviderModels } from './ProviderModels';
import { GrokProviderSessions } from './ProviderSessions';
import { GrokProviderState } from './ProviderState';
import { GrokProviderNormalizer } from './ProviderNormalizer';
import { GrokProviderUsage } from './ProviderUsage';
import { sendGrokCliPrompt, sendGrokTuiPrompt, sendGrokAcpPrompt } from './tui';
import { applyMcpStartupEnv } from '../../core/mcpStartupTimeout';

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

  // grok-cli now RESUMES its own workspace session across turns (like grok-tui) so
  // conversation context accumulates. Prefer the persisted id; fall back to disk
  // detection (newest session dir on disk) when session-state.json has none.
  override resolveSession(root: string) {
    return Promise.resolve(getSessionId(root, 'grok-cli') ?? getGrokLatestSessionId(root));
  }

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    // Grok kills slow MCP servers at 30s and IGNORES startup_timeout_sec in
    // config.toml — the env var below is what it actually honors. Set it (only if
    // unset) so the grok child inherits it.
    applyMcpStartupEnv('grok', req.settings);
    sendGrokCliPrompt(req.root, req.combinedFile, req.resolvedSessionId, req.stdoutFile, req.exitFile,
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

  override resolveSession(root: string) {
    return Promise.resolve(getSessionId(root, 'grok-tui') ?? getGrokLatestSessionId(root));
  }

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    // See GrokCliProvider: honor GROK_MCP_STARTUP_TIMEOUT_SECS (grok ignores the
    // config.toml startup_timeout_sec). launchSession also stamps it onto the
    // tmux pane env, since that pane inherits the tmux server env, not ours.
    applyMcpStartupEnv('grok', req.settings);
    sendGrokTuiPrompt(req.root, req.combinedFile, req.resolvedSessionId, req.stdoutFile, req.exitFile,
      ctx.log, req.settings.grokModel || undefined, ctx.showOutput);
    return {};
  }
}

/**
 * grok-acp — first-class provider for grok's PERSISTENT ACP session (1.4.196).
 * Where grok-cli / grok-tui use the ACP transport only when grokAcpEnabled()
 * (and otherwise fall back to headless / tmux), grok-acp ALWAYS drives one
 * long-lived `grok agent … stdio` process via GrokAcpSession (GROK_ACP_SPEC):
 * initialize → session/new|load → session/prompt → streamed session/update →
 * turn result. The process STAYS ALIVE between turns and session/load restores
 * context, so conversation state accumulates. Mirrors the opencode persistent
 * pattern (an in-process long-lived session that spawns inside dispatch() and
 * returns {} rather than a shell command) — hence ProviderKind 'sdk'. If the ACP
 * handshake can't be established (older grok / transient spawn failure),
 * sendGrokAcpPrompt transparently falls back to the headless one-shot path so
 * nothing regresses. Reuses the grok family's events/normalizer ('grok-acp'),
 * model key (grokModel, via the 'grok' prefix), and session-id resume.
 */
export class GrokAcpProvider extends ProviderManager {
  readonly id: ProviderId = 'grok-acp';
  readonly label = 'Grok ACP';
  // 'sdk': a persistent in-process session (spawns inside dispatch, returns {}),
  // like opencode-sdk — NOT a VS Code terminal ('tui') or a per-turn shell ('cli').
  readonly kind: ProviderKind = 'sdk';
  readonly family = 'grok';
  readonly events = new GrokProviderEvents('grok-acp');
  readonly models = new GrokProviderModels();
  readonly sessions = new GrokProviderSessions();
  readonly state = new GrokProviderState();
  readonly normalizer = new GrokProviderNormalizer('grok-acp');
  readonly usage = new GrokProviderUsage();

  // Resume the cwd's grok session across turns (same as grok-tui / grok-cli):
  // prefer the persisted id, fall back to the newest grok session dir on disk.
  override resolveSession(root: string) {
    return Promise.resolve(getSessionId(root, 'grok-acp') ?? getGrokLatestSessionId(root));
  }

  async dispatch(req: DispatchRequest, ctx: { log: Logger; showOutput?: () => void }): Promise<DispatchOutcome> {
    // Honor GROK_MCP_STARTUP_TIMEOUT_SECS (grok ignores config.toml's value).
    applyMcpStartupEnv('grok', req.settings);
    // ALWAYS the persistent ACP path — never gated by grokAcpEnabled(): that is
    // the whole point of this provider. sendGrokAcpPrompt spawns/reuses the
    // per-root GrokAcpSession, streams the turn to stdoutFile, and writes exitFile.
    sendGrokAcpPrompt(req.root, req.combinedFile, req.resolvedSessionId, req.stdoutFile, req.exitFile,
      ctx.log, 'grok-acp', req.settings.grokModel || undefined, ctx.showOutput);
    return {};
  }
}
