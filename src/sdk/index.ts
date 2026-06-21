import { TaskLoopRunner } from '../taskLoop';
import { sendPromptToAi } from '../dispatcher';
import { NodeFileWatcher, NodeProcessLauncher } from '../core/adapters';
import { ProviderId, PROVIDERS } from '../providers';
import { loadSettingsForRoot } from '../core/settingsLoader';

// ---------------------------------------------------------------------------
// AutoDev standalone SDK — use without VS Code.
// ---------------------------------------------------------------------------

export interface LoopStartOptions {
  /** AI provider to use (default: 'claude-cli') */
  provider?: ProviderId;
  /** Absolute path to the workspace / project root (default: process.cwd()) */
  cwd?: string;
  /** Logger (default: console.log) */
  log?: (msg: string) => void;
}

class LoopApi {
  private _runner = new TaskLoopRunner();

  async start(options: LoopStartOptions = {}): Promise<void> {
    const root = options.cwd ?? process.cwd();
    const launcher = new NodeProcessLauncher();
    const log = options.log ?? console.log;
    // Provider resolution order: explicit option → `.autodev/settings.json`
    // provider (parity with the VS Code shell, which reads the same field) →
    // 'claude-cli' fallback. Guard against an unknown settings value.
    const settingsProvider = loadSettingsForRoot(root).provider as ProviderId | undefined;
    const provider: ProviderId =
      options.provider
      ?? (settingsProvider && settingsProvider in PROVIDERS ? settingsProvider : undefined)
      ?? 'claude-cli';
    await this._runner.start({
      workspaceRoot: root,
      fileWatcher: new NodeFileWatcher(),
      sendToAi: (prompt, _label, includeProfile, messageFile) =>
        sendPromptToAi(provider, prompt, log, launcher, root, includeProfile, messageFile),
      log,
      getActiveProvider: () => provider,
      onStatusChange: () => {},
    });
  }

  stop(): void {
    this._runner.stop();
  }
}

export const AutoDev = {
  loop: new LoopApi(),
};
