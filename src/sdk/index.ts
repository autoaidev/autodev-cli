import { TaskLoopRunner } from '../taskLoop';
import { sendPromptToAi } from '../dispatcher';
import { NodeFileWatcher, NodeProcessLauncher } from '../core/adapters';
import { ProviderId, PROVIDERS } from '../providers';
import { loadSettingsForRoot } from '../core/settingsLoader';
import { closeAllOpencodeSdkClients } from '../providers/opencodeSdkProvider';
import { closeAllClaudeTuiClients } from '../providers/claudeTuiProvider';
import { closeAllCopilotSdkSessions } from '../providers/copilotSdkProvider';

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
  /** Run until the TODO drains, then stop and resolve (default: false = poll forever). */
  once?: boolean;
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
    const callbacks = {
      workspaceRoot: root,
      fileWatcher: new NodeFileWatcher(),
      sendToAi: (prompt: string, _label: string, includeProfile?: boolean, messageFile?: string) =>
        sendPromptToAi(provider, prompt, log, launcher, root, includeProfile, messageFile),
      log,
      getActiveProvider: () => provider,
      onStatusChange: () => {},
    };

    if (options.once) {
      // Resolve as soon as the queue drains and stop the loop — the runner's
      // start() promise does NOT resolve on stop(), so we gate on onAllTasksDone
      // ourselves. stop() also tears down persistent SDK servers so the process
      // can exit cleanly.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) { return; } done = true; this.stop(); resolve(); };
        void this._runner.start({ ...callbacks, onAllTasksDone: finish }).catch(finish);
      });
      return;
    }

    await this._runner.start(callbacks);
  }

  stop(): void {
    this._runner.stop();
    // Close persistent in-process SDK/TUI servers (opencode-sdk, claude-tui,
    // copilot-sdk). They hold the Node event loop open, so without this a
    // standalone `autodev start` never exits after the loop stops — the VS Code
    // shell does this in deactivate(), the headless path must do it here.
    this.closePersistent();
  }

  /** Tear down every persistent provider server/session across all roots. */
  closePersistent(): void {
    try { closeAllOpencodeSdkClients(); } catch { /* ignore */ }
    try { closeAllClaudeTuiClients(); } catch { /* ignore */ }
    try { closeAllCopilotSdkSessions(); } catch { /* ignore */ }
  }
}

export const AutoDev = {
  loop: new LoopApi(),
};
