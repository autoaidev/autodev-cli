// ---------------------------------------------------------------------------
// Provider contract — DTOs + interfaces (SOLID: interface segregation +
// dependency inversion). The dispatcher depends on IProvider, never on a
// concrete provider, so adding a provider means adding a class + a registry
// entry (open/closed) with zero changes to the dispatch orchestration.
// ---------------------------------------------------------------------------

import { ProviderId } from '../../providers';
import { AutodevSettings } from '../settingsLoader';
import { IProcessLauncher } from '../adapters';

export type ProviderKind = 'cli' | 'sdk' | 'tui';
export type Logger = (msg: string) => void;

/**
 * DTO — everything a provider needs to dispatch ONE task. Immutable; built by
 * the dispatcher's shared setup phase and handed to the resolved provider.
 */
export interface DispatchRequest {
  /** Absolute workspace root. */
  readonly root: string;
  /** Absolute path to `.autodev/AGENT_PROFILE.md`. */
  readonly agentProfileFile: string;
  /** Absolute path to the task MESSAGE file. */
  readonly messageFile: string;
  /** Absolute path to a profile+message combined file (built on demand). */
  readonly combinedFile: string;
  /** Session id to resume, or undefined for a fresh session. */
  readonly resolvedSessionId?: string;
  /** Whether to inject the agent profile into the prompt. */
  readonly includeProfile: boolean;
  /** Loaded workspace settings. */
  readonly settings: AutodevSettings;
  /** Per-message stdout sink. */
  readonly stdoutFile: string;
  /** Per-message exit-code sink. */
  readonly exitFile: string;
}

/**
 * DTO — the result of a dispatch. CLI providers return a shell `command` for
 * the orchestrator to launch via the injected IProcessLauncher; in-process
 * (sdk/tui) providers spawn directly and return `command: undefined`.
 */
export interface DispatchOutcome {
  readonly command?: string;
}

/** Collaborators passed to a provider at dispatch time (dependency injection). */
export interface DispatchContext {
  readonly log: Logger;
  readonly launcher: IProcessLauncher;
  /** Reveal output UI (VS Code shell only); no-op headless. */
  readonly showOutput?: () => void;
}

/**
 * A pluggable AI backend. One instance per provider id, registered in the
 * ProviderRegistry. Methods are intentionally minimal (interface segregation):
 * CLI providers leave isBusy/close as the BaseProvider defaults.
 */
export interface IProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly kind: ProviderKind;

  /** Resolve a session id to resume (probe/list), or undefined for fresh. */
  resolveSession(root: string, log: Logger): Promise<string | undefined>;

  /** Build a shell command (cli) or send in-process (sdk/tui) and return the outcome. */
  dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchOutcome>;

  /** True while a persistent in-process turn is still running (sdk/tui only). */
  isBusy(root: string): boolean;

  /** Tear down any persistent server/session for this root (sdk/tui only). */
  close(root: string, log: Logger): void;
}
