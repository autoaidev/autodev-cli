import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { parseTodo, pickNextTask, countRemaining, Task, pruneTodoToArchive, shortId } from './todo';
import { todoWriter } from './todoWriteManager';
import { buildPrompt } from './prompt';
import { writeMessageFile } from './messageBuilder';
import { WebhookClient, WebhookEvent, sendDiscordBotMessage } from './webhook';
import { loadSettingsForRoot, AutodevSettings } from './core/settingsLoader';
import { IFileWatcher, IDisposable } from './core/adapters';
import { getClaudeSessionCursor, parseClaudeStateSince, findLatestClaudeSession, setClaudeSessionName } from './dispatcher';
import { getLatestOpenCodeSessionId, runOpenCodeCompact } from './providers/opencodeCliProvider';
import { getOpenCodeSessionIdFromHooks, isOpenCodeCliActive, openCodeExitedCleanly } from './openCodeHooksManager';
import { runClaudeCompact, runClaudeClear } from './providers/claudeCliProvider';
import { runClaudeTuiCompact, runClaudeTuiClear, getClaudeTuiLatestSessionId, isClaudeTuiBusy, getClaudeTuiLastActivity, forceIdleClaudeTui, steerClaudeTui, closeClaudeTuiClient } from './providers/claudeTuiProvider';
import { sendCopilotSdkPrompt, isCopilotSdkBusy, getLatestCopilotSdkSessionId, readCopilotSdkOutputSince, closeCopilotSdkSession, closeAllCopilotSdkSessions, steerCopilotSdk } from './providers/copilotSdkProvider';
import { runOpencodeSdkCompact, getOpencodeSdkLatestSessionId, isOpencodeSdkBusy, getOpencodeSdkActivity, closeOpencodeSdkClient, forceIdleOpencodeSdk, steerOpencodeSdk } from './providers/opencodeSdkProvider';
import { isGrokTuiBusy, steerGrokTui, closeGrokTuiSession, forceIdleGrokTui } from './providers/grokTuiProvider';
import { captureAndSaveSessionId, saveSessionId, getSessionId, clearSessionId, stdoutFilePath, exitFilePath } from './sessionState';
import { readClaudeOutputSince } from './dispatcher';
import { PROVIDERS, ProviderId } from './providers';
import { DiscordPoller } from './discordPoller';
import { PeriodicActionManager, PERIODIC_ACTIONS } from './periodicActions';
import { DiscordGateway } from './discordGateway';
import { WebhookPoller } from './webhookPoller';
import { EmailTaskPoller } from './emailPoller';
import { loadProjectUserMcp, saveProjectUserMcp, sanitizeRemoteMcpEntries } from './core/projectMcp';
import { ConfigManager } from './configManager';
import { createAgentBackup, uploadAgentBackup, downloadAgentBackup, restoreAgentBackup, isTrustedDownloadUrl } from './agentBackup';
import { CLI_VERSION } from './version';

// ---------------------------------------------------------------------------
// TaskLoopRunner — mirrors PHP Loop.php
// ---------------------------------------------------------------------------

export type LoopState = 'idle' | 'running' | 'stopping' | 'paused';

// ---------------------------------------------------------------------------
// Rate-limit + context-length errors
// ---------------------------------------------------------------------------

import { RateLimitError, RateLimitDetector, AuthError, AuthDetector } from './rateLimit';
import { CliExitHandler } from './cliExit';
import { LiveNarrationStreamer, appendHookEventLine, stripAnsi } from './core/liveNarration';

class ContextLengthError extends Error {
  constructor(readonly rawMessage: string) {
    super(rawMessage);
    this.name = 'ContextLengthError';
  }
}

/** Thrown when Claude's autocompact is thrashing — /clear is needed. */
class ThrashingError extends ContextLengthError {
  constructor(rawMessage: string) {
    super(rawMessage);
    this.name = 'ThrashingError';
  }
}

// ---------------------------------------------------------------------------
// RetryScheduler — single clearable timer for rate-limit resume
// ---------------------------------------------------------------------------

class RetryScheduler {
  private _timer: NodeJS.Timeout | null = null;

  schedule(ms: number, cb: () => void): void {
    this.clear();
    this._timer = setTimeout(cb, ms);
  }

  clear(): void {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
  }
}

export interface LoopCallbacks {
  /** Send a prompt to the active AI provider. messageFile is the absolute path of the written .md file for CLI providers. */
  sendToAi: (prompt: string, taskLabel: string, includeProfile?: boolean, messageFile?: string) => Promise<void>;
  /** Append a message to the extension's output channel */
  log: (msg: string) => void;
  /** Called whenever the loop state changes so the sidebar can refresh */
  onStatusChange: (state: LoopState, currentTask?: string) => void;
  /** Called when Claude's current tool activity changes (undefined = idle/done) */
  onActivityChange?: (activity: string | undefined) => void;
  /** Called once when the queue drains (all tasks done). Used by `--once` to stop. */
  onAllTasksDone?: () => void;
  /** Returns the currently selected provider ID (live, not from settings file) */
  getActiveProvider: () => ProviderId;
  /** Transiently override the active provider (e.g. fallback on rate limit). */
  setActiveProvider?: (id: ProviderId) => void;
  /** Absolute path to the workspace root directory */
  workspaceRoot: string;
  /** File watcher used to monitor TODO.md and output files */
  fileWatcher: IFileWatcher;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read a CLI stdout file and return its content as a UTF-8 string.
 * Handles all BOM variants that PowerShell may write:
 *   \xFF\xFE → UTF-16 LE (Tee-Object default on PS5)
 *   \xEF\xBB\xBF → UTF-8 with BOM (Out-File -Encoding UTF8 on PS5)
 *   no BOM → plain UTF-8 (PS7)
 */
function readOutputFile(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) { return ''; }
  if (raw[0] === 0xFF && raw[1] === 0xFE) {
    // UTF-16 LE
    return raw.subarray(2).toString('utf16le').trim();
  }
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    // UTF-8 BOM
    return raw.subarray(3).toString('utf8').trim();
  }
  return raw.toString('utf8').trim();
}

/** First line of task text, capped at 200 chars — safe to post to Discord. */
function discordLabel(taskText: string): string {
  const first = taskText.split('\n')[0].trim();
  return first.length > 200 ? first.slice(0, 197) + '\u2026' : first;
}

function resolveGitInfo(workDir: string): { gitRepo: string; gitBranch: string } {
  const run = (cmd: string) => {
    try { return execSync(cmd, { cwd: workDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return ''; }
  };
  return {
    gitRepo:   run('git remote get-url origin'),
    gitBranch: run('git rev-parse --abbrev-ref HEAD'),
  };
}

export class TaskLoopRunner {
  private _state: LoopState = 'idle';
  private _currentTask: string | undefined;
  private _taskWatcher: IDisposable | undefined;
  private _iterations = 0;
  private _cb: LoopCallbacks | undefined;
  private _webhook: WebhookClient | null = null;
  private _settings: AutodevSettings | undefined;
  private _workspaceRoot: string | undefined;
  private _discordPoller: DiscordPoller | null = null;
  private _discordGateway: DiscordGateway | null = null;
  private _webhookPoller: WebhookPoller | null = null;
  private _emailPoller: EmailTaskPoller | null = null;
  /** True after we last told the server "all_tasks_done" — cleared on task_start.
   *  Used to re-assert idle state on WS reconnect, otherwise agent_online flips
   *  the server-side status back to 'active' even though we have no work. */
  private _idleNotified = false;
  private _pollerIntervals: NodeJS.Timeout[] = [];
  private _hooksFileOffset = 0;
  /** Recently-forwarded hook-line hashes → first-seen timestamp (ms).
   *  Used to suppress byte-identical hook events that get appended multiple
   *  times to the shared JSONL (Copilot CLI fires the same hook from every
   *  parallel session in the same workspace, all writing to one homedir
   *  file). Entries older than HOOKS_DEDUPE_WINDOW_MS are pruned each tick. */
  private _hookLineSeen = new Map<string, number>();
  private _taskCompletionAbort: (() => void) | null = null;
  private _retryScheduler = new RetryScheduler();
  private _resumeResolve: (() => void) | null = null;
  /** Resolves the idle no-task sleep early when a poller appends a new task. */
  private _idleSleepWake: (() => void) | null = null;
  private _resumeAt: Date | undefined;
  /** When the loop is paused for reauth/rate-limit, the event+payload to re-emit
   *  on a WS reconnect INSTEAD of agent_online/task_start. Reconnects are routine
   *  (heartbeat, NAT blips, server restart); without this a reconnect during a
   *  pause flips the server status back to active/working and erases the
   *  operator's 'needs reauth' / 'rate limited' badge, stranding the agent.
   *  Cleared on retry()/resume. */
  private _pauseReason: { event: WebhookEvent; payload: Record<string, unknown> } | null = null;
  /** When fallback is active: the saved main provider and when to switch back. */
  private _mainProviderBeforeFallback: ProviderId | null = null;
  private _mainProviderResumeAt: Date | undefined;
  private _gitRepo: string = '';
  private _gitBranch: string = '';
  private _hostname: string = '';
  private _completedCount = 0;
  private _failedCount = 0;
  private _loopStartTime = 0;
  /** Task lines that have already had /compact run — prevents infinite compact loops. */
  private _compactedTaskLines = new Set<number>();
  /** True while a compact operation is in progress — prevents nested/recursive compacts. */
  private _compacting = false;
  /** Timestamp (ms) when compact was last run — used to throttle auto-compact (minimum 2min between compacts). */
  private _lastCompactTime = 0;
  /** Dispatch attempt counter per task key (id or text). After 3 failed attempts the
   *  loop force-marks the task done so it doesn't block the queue indefinitely. */
  private _taskAttempts = new Map<string, number>();
  /** Task keys (id or text) flagged as provider hard-failures this session.
   *  These must NOT be auto-completed by the give_up / stranded-[~] heuristics —
   *  a blocked task stays [~] + reported failed until it is retried. Cleared when
   *  a fresh [ ] dispatch of the same task begins (provider presumably recovered). */
  private _blockedTasks = new Set<string>();
  /** Counts completed tasks since the last auto-compact run. */
  private _autoCompactCounter = 0;
  /** Counts completed tasks since the last session reset. */
  private _resetSessionCounter = 0;
  /** Counts tasks dispatched since the last profile-included send. */
  private _profileSentCounter = 0;
  /** Manages all "every N tasks" periodic action counters. */
  private readonly _periodicMgr = new PeriodicActionManager();

  get state(): LoopState { return this._state; }
  get currentTask(): string | undefined { return this._currentTask; }
  get resumeAt(): Date | undefined { return this._resumeAt; }

  /** Manually trigger a /compact on the current session for the given provider/root. */
  async compact(root: string, provider: ProviderId): Promise<void> {
    const log = (m: string) => this._cb?.log(m);

    // Guard: prevent infinite compact loops
    if (this._compacting) {
      log('⚠️  Compact skipped: already compacting (infinite loop prevention)');
      return;
    }

    this._compacting = true;
    log(`🗜 Manual compact triggered (provider: ${provider})`);
    try {
      if (provider === 'claude-cli') {
        let sid = getSessionId(root, 'claude-cli');
        if (!sid) { sid = findLatestClaudeSession(root); }
        if (sid) { await runClaudeCompact(sid, root, log); log('🗜 Compact complete'); }
        else { log('⚠️ Compact: no Claude session ID found'); }
      } else if (provider === 'claude-tui') {
        let sid = getSessionId(root, 'claude-tui');
        if (!sid) { sid = getClaudeTuiLatestSessionId(root); }
        if (sid) { await runClaudeTuiCompact(root, sid, log); log('🗜 Compact complete'); }
        else { log('⚠️ Compact: no Claude TUI session ID found'); }
      } else if (provider === 'opencode-cli') {
        let sid = getSessionId(root, 'opencode-cli');
        if (!sid) { sid = await getLatestOpenCodeSessionId(root, log); }
        if (sid) { await runOpenCodeCompact(sid, root, log); log('🗜 Compact complete'); }
        else { log('⚠️ Compact: no OpenCode session ID found'); }
      } else if (provider === 'opencode-sdk') {
        await runOpencodeSdkCompact(root, log);
        log('🗜 Compact complete (opencode-sdk)');
      } else {
        log(`⚠️ Compact not supported for provider: ${provider}`);
      }
    } catch (e) {
      log(`⚠️ Compact failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this._compacting = false;
      this._lastCompactTime = Date.now();
    }
  }

  /** Manually trigger a /clear on the current Claude session for the given provider/root. */
  async clearSession(root: string, provider: ProviderId): Promise<void> {
    const log = (m: string) => this._cb?.log(m);
    log(`🗑 Manual /clear triggered (provider: ${provider})`);
    try {
      if (provider === 'claude-cli') {
        let sid = getSessionId(root, 'claude-cli');
        if (!sid) { sid = findLatestClaudeSession(root); }
        if (sid) {
          await runClaudeClear(sid, root, log);
          clearSessionId(root, 'claude-cli');
          log('🗑 /clear complete — session reset');
        } else { log('⚠️ /clear: no Claude session ID found'); }
      } else if (provider === 'claude-tui') {
        let sid = getSessionId(root, 'claude-tui');
        if (!sid) { sid = getClaudeTuiLatestSessionId(root); }
        if (sid) {
          await runClaudeTuiClear(root, sid, log);
          clearSessionId(root, 'claude-tui');
          log('🗑 /clear (TUI) complete — session reset');
        } else { log('⚠️ /clear: no Claude TUI session ID found'); }
      } else {
        log(`⚠️ /clear not supported for provider: ${provider}`);
      }
    } catch (e) {
      log(`⚠️ /clear failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resume the loop after a rate-limit pause. Clears the scheduled timer. */
  retry(): void {
    if (this._state !== 'paused') { return; }
    this._retryScheduler.clear();
    this._resumeAt = undefined;
    this._pauseReason = null;
    this._mainProviderBeforeFallback = null;
    this._mainProviderResumeAt = undefined;
    this._setState('running');
    const r = this._resumeResolve;
    this._resumeResolve = null;
    r?.();
  }

  async start(callbacks: LoopCallbacks): Promise<void> {
    if (this._state === 'running') {
      callbacks.log('Task loop already running');
      return;
    }

    this._cb = callbacks;
    this._iterations = 0;
    this._compactedTaskLines.clear();
    this._taskAttempts.clear();
    this._blockedTasks.clear();
    this._autoCompactCounter = 0;
    this._resetSessionCounter = 0;
    this._profileSentCounter = 0;
    this._periodicMgr.resetAndPersist(callbacks.workspaceRoot);
    this._hookLineSeen.clear();
    this._setState('running');

    const settings = loadSettingsForRoot(callbacks.workspaceRoot);
    const root = callbacks.workspaceRoot;
    if (!root) {
      callbacks.log('No workspace folder open');
      this._setState('idle');
      return;
    }

    this._settings = settings;
    this._workspaceRoot = root;
    this._completedCount = 0;
    this._failedCount = 0;
    this._loopStartTime = Date.now();
    this._hostname = os.hostname();
    const git = resolveGitInfo(root);
    this._gitRepo   = git.gitRepo;
    this._gitBranch = git.gitBranch;

    // Wire per-provider MCP configs at startup so the A2A tools are always
    // available for whatever provider this agent runs — not just after an
    // `mcp_update` push. Without this, a per-project config (e.g. opencode.json)
    // never gets written and opencode/copilot agents start with no send_message
    // tool. Office-bound only (sync auto-attaches the pixel-office server from
    // serverApiKey); harmless no-op otherwise.
    if (settings.serverApiKey && settings.serverBaseUrl) {
      try {
        ConfigManager.syncProjectMcpServers(root, (m) => callbacks.log(m));
        void ConfigManager.reportProjectMcp(root, (m) => callbacks.log(m));
      } catch (err) {
        callbacks.log(`⚠️ startup MCP sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this._webhook = (settings.serverBaseUrl && settings.webhookSlug)
      ? new WebhookClient(
          settings.serverBaseUrl.replace(/\/$/, '') + '/webhook/' + settings.webhookSlug,
          settings.serverApiKey,
          settings.webhookSlug,  // use slug as contextId so server can find the agent
        )
      : null;
    // `cliVersion` rides in the meta merged into every webhook frame — notably
    // the agent_online (hello) frame — so pixel-office can record which CLI
    // version each agent runs (surfacing stale, steer-incapable agents).
    this._webhook?.setMeta({ provider: settings.provider, cliVersion: CLI_VERSION, workDir: root, hostname: this._hostname, gitRepo: this._gitRepo, gitBranch: this._gitBranch });

    this._discordPoller = (settings.discordToken && settings.discordChannelId && settings.discordOwners)
      ? new DiscordPoller(settings.discordToken, settings.discordChannelId, settings.discordOwners)
      : null;

    this._discordGateway = settings.discordToken
      ? new DiscordGateway(settings.discordToken)
      : null;

    this._webhookPoller = (settings.serverBaseUrl && settings.serverApiKey && settings.webhookSlug)
      ? new WebhookPoller(settings.serverBaseUrl, settings.serverApiKey, settings.webhookSlug)
      : null;

    // Email task ingestion — pulls IMAP creds from the Email MCP entry's env
    // block. Disabled unless AUTODEV_EMAIL_RECEIVE_TASKS is "true".
    this._emailPoller = this._buildEmailPoller(settings);

    // When the poller is WebSocket-backed, route outbound events through the
    // same WS connection instead of HTTP POST (which fails for ws:// URLs).
    if (this._webhook && this._webhookPoller?.isWebSocket) {
      this._webhook.setWsSender((frame) => this._webhookPoller!.sendFrame(frame));
      // Re-send agent_online once the WS connection is actually established so
      // the server can record the VNC host/port from the live connection context.
      this._webhookPoller.setOnConnect(() => {
        // If the loop is no longer running (stopped or stopping), re-assert
        // offline status on reconnect instead of claiming agent_online.
        if (this._state === 'idle' || this._state === 'stopping') {
          this._notifyWebhook('agent_offline', {
            workDir:   this._workspaceRoot ?? '',
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
          return;
        }
        // If the loop is paused (reauth / rate-limit), a routine reconnect must
        // NOT re-emit agent_online + task_start — that flips the server status
        // back to active/working and erases the reauth/rate-limit alert, so a
        // stranded agent looks like it is busy working. Re-assert the pause
        // reason instead and never send task_start while paused.
        if (this._state === 'paused') {
          if (this._pauseReason) {
            this._notifyWebhook(this._pauseReason.event, this._pauseReason.payload);
          }
          return;
        }
        this._notifyWebhook('agent_online', {
          // provider + cliVersion so the office labels the agent correctly. Without
          // provider here, a grok/opencode loop (whose hooks are Claude-style) is
          // mis-detected as 'claude' by the office's hook-based fallback.
          provider:           this._settings?.provider,
          cliVersion:         CLI_VERSION,
          hostname:           this._hostname,
          workDir:            this._workspaceRoot ?? '',
          gitRepo:            this._gitRepo,
          gitBranch:          this._gitBranch,
          vncEnabled:         this._settings?.vncEnabled ?? false,
          vncHost:            this._settings?.vncEnabled ? (this._settings?.vncHost || undefined) : undefined,
          vncPort:            this._settings?.vncEnabled ? (this._settings?.vncPort ?? 5900) : undefined,
          rdpEnabled:         this._settings?.rdpEnabled ?? false,
          rdpHost:            this._settings?.rdpEnabled ? (this._settings?.rdpHost || undefined) : undefined,
          rdpPort:            this._settings?.rdpEnabled ? (this._settings?.rdpPort ?? 3389) : undefined,
          fileBrowserEnabled: this._settings?.enableFileBrowser ?? false,
          gitEnabled:         this._settings?.gitEnabled ?? false,
        });
        // Re-sync working state if the WS dropped mid-task
        if (this._currentTask) {
          this._notifyWebhook('task_start', {
            iteration: this._iterations,
            task:      { text: this._currentTask },
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
        }
        // Re-sync idle state if we previously drained the queue — otherwise the
        // server-side `agent_online` handler flips status back to 'active' and
        // the agent looks busy when it isn't.
        if (!this._currentTask && this._idleNotified) {
          this._notifyWebhook('agent_idle', {
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
        }
      });
    }

    // Pass VNC password so the poller can authenticate incoming vnc_session requests.
    if (this._webhookPoller && settings.vncEnabled && settings.vncPassword) {
      this._webhookPoller.setVncPassword(settings.vncPassword);
    }
    if (this._webhookPoller) {
      this._webhookPoller.setGitEnabled(settings.gitEnabled ?? false);
      this._webhookPoller.setFileBrowserEnabled(settings.enableFileBrowser ?? false);
      // VNC / RDP session bridges are honored only when explicitly enabled —
      // an ungated frame would let a remote party open outbound bridges.
      this._webhookPoller.setVncEnabled(settings.vncEnabled ?? false);
      this._webhookPoller.setRdpEnabled(settings.rdpEnabled ?? false);
      // Wake the idle no-task sleep instantly when a WS-pushed task arrives.
      this._webhookPoller.setOnTaskAppend(() => this._wakeIdleSleep());
      this._webhookPoller.setOnSteer((text, onDelivered) => void this._handleSteer(text, onDelivered));
      this._webhookPoller.setOnCommand((cmd) => this._handleCommand(cmd));
      this._webhookPoller.setOnMcpUpdate((entries) => this._handleMcpUpdate(entries));
      this._webhookPoller.setOnExportRequest((agentId) => void this._handleExportRequest(agentId));
      this._webhookPoller.setOnRestoreRequest((agentId, downloadUrl) => void this._handleRestoreRequest(agentId, downloadUrl));
      this._webhookPoller.setOnExportConfig((exportEnabled, exportDailyBackup, agentId) => this._handleExportConfig(exportEnabled, exportDailyBackup, agentId));
    }
    if (this._discordPoller) {
      this._discordPoller.setOnCommand((cmd) => this._handleCommand(cmd));
    }
    if (this._webhookPoller && settings.rdpEnabled) {
      this._webhookPoller.setRdpSettings({
        host:       settings.rdpHost       || undefined,
        port:       settings.rdpPort       ?? 3389,
        username:   settings.rdpUsername   || undefined,
        password:   settings.rdpPassword   || undefined,
        domain:     settings.rdpDomain     || undefined,
        guacWsUrl:  settings.rdpGuacWsUrl  || undefined,
      });
    }

    const todoPath = settings.todoPath || path.join(root, 'TODO.md');

    // Seed Discord cursor to ignore history before the loop started
    if (this._discordPoller) {
      await this._discordPoller.initialize();
    }

    if (this._emailPoller) {
      try {
        await this._emailPoller.initialize();
        callbacks.log('🔧 Email task poller started — checking inbox every 10s');
      }
      catch (e) { callbacks.log(`Email poller init failed: ${e instanceof Error ? e.message : String(e)}`); }
    } else {
      const root = this._workspaceRoot;
      const userMcp = root ? loadProjectUserMcp(root) : {};
      const entry = userMcp['zerolib-email'];
      const env = entry?.env ?? {};
      const reasons: string[] = [];
      if (!entry) reasons.push('no zerolib-email entry in .mcp.json');
      else {
        if (String(env.AUTODEV_EMAIL_RECEIVE_TASKS).toLowerCase() !== 'true') reasons.push('AUTODEV_EMAIL_RECEIVE_TASKS != "true"');
        if (!env.MCP_EMAIL_SERVER_IMAP_HOST) reasons.push('IMAP host missing');
        if (!(env.MCP_EMAIL_SERVER_USER_NAME || env.MCP_EMAIL_SERVER_EMAIL_ADDRESS)) reasons.push('IMAP user/email missing');
        if (!env.MCP_EMAIL_SERVER_PASSWORD) reasons.push('IMAP password missing');
      }
      if (reasons.length) callbacks.log(`🔧 Email task poller NOT started: ${reasons.join('; ')}`);
    }

    // Connect to Discord Gateway so the bot appears online
    this._discordGateway?.connect();

    // Start WebSocket connection (no-op for HTTP pollers)
    if (this._webhookPoller) {
      this._webhookPoller.start(todoPath, (msg) => callbacks.log(msg), root);
    }

    // Start independent background polling loops — run even while AI is processing a task
    this._startPollers(todoPath);

    callbacks.log(`autodev-cli v${CLI_VERSION}`);
    callbacks.log(`Task loop starting — TODO: ${todoPath}`);
    this._notifyWebhook('loop_start', {
      provider:  settings.provider,
      workDir:   root,
      gitRepo:   this._gitRepo,
      gitBranch: this._gitBranch,
    });
    this._notifyWebhook('agent_online', {
      provider:           settings.provider,
      cliVersion:         CLI_VERSION,
      hostname:           this._hostname,
      workDir:            root,
      gitRepo:            this._gitRepo,
      gitBranch:          this._gitBranch,
      vncEnabled:         settings.vncEnabled ?? false,
      vncHost:            settings.vncEnabled ? (settings.vncHost || undefined) : undefined,
      vncPort:            settings.vncEnabled ? (settings.vncPort ?? 5900) : undefined,
      rdpEnabled:         settings.rdpEnabled ?? false,
      rdpHost:            settings.rdpEnabled ? (settings.rdpHost || undefined) : undefined,
      rdpPort:            settings.rdpEnabled ? (settings.rdpPort ?? 3389) : undefined,
      fileBrowserEnabled: settings.enableFileBrowser ?? false,
      gitEnabled:         settings.gitEnabled ?? false,
    });
    this._notifyDiscord('🚀 AutoDev task loop started');

    // Auto-run `cozempic init` for Claude CLI projects so the guard daemon and
    // pruning hooks are wired automatically — the user only needs cozempic on
    // their PATH; no per-project manual step required.
    if (settings.provider === 'claude-cli') {
      this._runCozempicInit(root, callbacks.log.bind(callbacks));
    }

    this._checkDailyBackup(settings.agentId || settings.webhookSlug || undefined);

    try {
      await this._runLoop(todoPath, settings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.log(`Task loop error: ${msg}`);
    }

    const elapsed = Math.round((Date.now() - this._loopStartTime) / 1000);
    this._notifyWebhook('loop_complete', {
      total:     this._completedCount + this._failedCount,
      success:   this._completedCount,
      failed:    this._failedCount,
      elapsed,
      workDir:   root,
      gitRepo:   this._gitRepo,
      gitBranch: this._gitBranch,
    });
    this._notifyWebhook('agent_offline', {
      total:     this._completedCount + this._failedCount,
      success:   this._completedCount,
      failed:    this._failedCount,
      elapsed,
      workDir:   root,
      gitRepo:   this._gitRepo,
      gitBranch: this._gitBranch,
    });
    this._notifyDiscord('👋 AutoDev loop ended');
    this._stopPollers();
    this._currentTask = undefined;
    this._webhook = null;
    this._discordPoller = null;
    this._discordGateway?.destroy();
    this._discordGateway = null;
    this._webhookPoller = null;
    if (this._emailPoller) { void this._emailPoller.dispose(); this._emailPoller = null; }
    this._setState('idle');
    callbacks.log('Task loop stopped');
  }

  stop(): void {
    if (this._state !== 'running' && this._state !== 'paused') { return; }
    this._setState('stopping');
    this._retryScheduler.clear();
    this._resumeAt = undefined;
    this._pauseReason = null;
    this._mainProviderBeforeFallback = null;
    this._mainProviderResumeAt = undefined;
    // Unblock _pause() if we're currently suspended
    const r = this._resumeResolve;
    this._resumeResolve = null;
    r?.();
    // Unblock the idle no-task sleep immediately
    const w = this._idleSleepWake;
    this._idleSleepWake = null;
    w?.();
    this._disposeWatcher();
    this._stopPollers();
    // Abort any in-progress task wait immediately
    this._taskCompletionAbort?.();
    this._taskCompletionAbort = null;
    // Notify Pixel Office / webhook immediately — don't wait for the _runLoop
    // finally block which may never fire if the WS disconnects before cleanup.
    this._notifyWebhook('agent_offline', {
      workDir:   this._workspaceRoot,
      gitRepo:   this._gitRepo,
      gitBranch: this._gitBranch,
    });
    // Send discord goodbye right now (don't wait for cleanup path)
    this._notifyDiscord('⛔ AutoDev loop stopped');
    this._cb?.log('Task loop stop requested…');
  }

  /**
   * Stop the loop and, once it reaches idle, start it again with the same
   * callbacks. Useful for picking up new MCP server configs etc.
   */
  async restart(): Promise<void> {
    const savedCb = this._cb;
    if (!savedCb) { return; }
    if (this._state !== 'idle') {
      this.stop();
      const deadline = Date.now() + 15_000;
      while ((this._state as LoopState) !== 'idle' && Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 100));
      }
    }
    await this.start(savedCb);
  }

  /** Handle mcp_update pushed from pixel-office: write .mcp.json, sync all providers, restart loop. */
  private _handleMcpUpdate(entries: Record<string, unknown>): void {
    const root = this._workspaceRoot;
    if (!root) return;
    // Opt-in gate: writing remote-supplied MCP config spawns stdio child
    // processes on restart (code-execution surface). Ignore unless explicitly
    // enabled, mirroring enableFileBrowser / gitEnabled.
    if (!this._settings?.mcpUpdateEnabled) {
      this._cb?.log('🔒 mcp_update ignored — mcpUpdateEnabled is off (set it in .autodev/settings.json to allow)');
      return;
    }
    this._cb?.log('🔧 mcp_update received — validating and writing .mcp.json…');
    // Reject entries that would execute an arbitrary shell / path command.
    const { safe, rejected } = sanitizeRemoteMcpEntries(entries);
    if (rejected.length) {
      this._cb?.log(`⚠️ mcp_update dropped ${rejected.length} unsafe entr${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}`);
    }
    if (Object.keys(safe).length === 0) {
      this._cb?.log('⚠️ mcp_update had no safe entries — not writing config or restarting.');
      return;
    }
    try {
      saveProjectUserMcp(root, safe);
      ConfigManager.syncProjectMcpServers(root, (m) => this._cb?.log(m));
      void ConfigManager.reportProjectMcp(root, (m) => this._cb?.log(m));
      this._cb?.log('✅ MCP config synced to .mcp.json, opencode.json, .vscode/mcp.json — restarting loop…');
    } catch (err) {
      this._cb?.log(`⚠️ MCP update failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    void this.restart();
  }

  /** Handle export_request from pixel-office: create backup zip and upload. */
  private async _handleExportRequest(agentId: string): Promise<void> {
    const root = this._workspaceRoot;
    const settings = this._settings;
    // Opt-in gate: export reads session traces from outside the workspace
    // (~/.claude, ~/.copilot, opencode.db). Ignore unless explicitly enabled,
    // mirroring mcpUpdateEnabled / enableFileBrowser / gitEnabled.
    if (!settings?.exportEnabled) {
      this._cb?.log('🔒 export_request ignored — exportEnabled is off (set it in .autodev/settings.json to allow)');
      return;
    }
    if (!root || !settings?.serverBaseUrl || !settings?.serverApiKey) {
      this._cb?.log('⚠️ export_request ignored — serverBaseUrl/serverApiKey not configured');
      return;
    }
    this._cb?.log('📦 export_request received — building backup zip…');
    const tmpPath = path.join(os.tmpdir(), `agent-backup-${agentId}-${Date.now()}.zip`);
    try {
      await createAgentBackup(root, tmpPath);
      this._cb?.log('📤 Uploading backup to pixel-office…');
      const result = await uploadAgentBackup(tmpPath, agentId, settings.serverBaseUrl, settings.serverApiKey);
      this._saveLastBackupTime(root);
      this._cb?.log(`✅ Backup uploaded: ${result.filename}`);
    } catch (err) {
      this._cb?.log(`⚠️ Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /** Handle restore_request from pixel-office: download zip and restore workspace. */
  private async _handleRestoreRequest(agentId: string, downloadUrl: string): Promise<void> {
    const root = this._workspaceRoot;
    const settings = this._settings;
    // Opt-in gate: restore writes files OUTSIDE the workspace (~/.claude/projects,
    // ~/.copilot/session-state, opencode.db) — a host-mutating primitive. Ignore
    // unless explicitly enabled, mirroring mcpUpdateEnabled / enableFileBrowser.
    if (!settings?.exportEnabled) {
      this._cb?.log('🔒 restore_request ignored — exportEnabled is off (set it in .autodev/settings.json to allow)');
      return;
    }
    if (!root || !settings?.serverApiKey) {
      this._cb?.log('⚠️ restore_request ignored — serverApiKey not configured');
      return;
    }
    // The download carries the agent's Bearer credential and overwrites the
    // workspace, so the URL must point at the configured server origin — never
    // an attacker-chosen host from the WS frame.
    if (!isTrustedDownloadUrl(downloadUrl, settings.serverBaseUrl)) {
      this._cb?.log(`🔒 restore_request refused — downloadUrl origin does not match the configured server: ${downloadUrl}`);
      return;
    }
    this._cb?.log(`🔄 restore_request received — downloading backup from ${downloadUrl}…`);
    const tmpPath = path.join(os.tmpdir(), `agent-restore-${agentId}-${Date.now()}.zip`);
    try {
      await downloadAgentBackup(downloadUrl, tmpPath, settings.serverApiKey);
      this._cb?.log('📂 Restoring workspace from backup…');
      const result = await restoreAgentBackup(tmpPath, root);
      this._cb?.log(`✅ Restored ${result.workspaceFiles} workspace file(s) — restarting loop…`);
      void this.restart();
    } catch (err) {
      this._cb?.log(`⚠️ Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /** Handle export_config from pixel-office: persist exportEnabled + exportDailyBackup to settings. */
  private _handleExportConfig(exportEnabled: boolean, exportDailyBackup: boolean, agentId: string): void {
    const root = this._workspaceRoot;
    if (!root) return;
    try {
      const { loadSettingsForRoot: load, settingsWritePath } = require('./core/settingsLoader') as typeof import('./core/settingsLoader');
      const current = load(root);
      if (current.exportEnabled === exportEnabled && current.exportDailyBackup === exportDailyBackup && (!agentId || current.agentId === agentId)) return;
      current.exportEnabled     = exportEnabled;
      current.exportDailyBackup = exportDailyBackup;
      if (agentId) current.agentId = agentId;
      fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
      fs.writeFileSync(settingsWritePath(root), JSON.stringify(current, null, 2), 'utf8');
      this._cb?.log(`⚙️ Export config updated: enabled=${exportEnabled}, dailyBackup=${exportDailyBackup}`);
    } catch (err) {
      this._cb?.log(`⚠️ export_config write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Check if a daily backup is due and trigger it automatically. */
  private _checkDailyBackup(agentId: string | undefined): void {
    if (!agentId) return;
    const settings = this._settings;
    if (!settings?.exportEnabled || !settings?.exportDailyBackup) return;
    const root = this._workspaceRoot;
    if (!root) return;
    const MS_PER_DAY = 86_400_000;
    const statePath = path.join(root, '.autodev', 'last_backup.json');
    try {
      if (fs.existsSync(statePath)) {
        const { ts } = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { ts: number };
        if (Date.now() - ts < MS_PER_DAY) return;
      }
    } catch { /* proceed */ }
    this._cb?.log('⏰ Daily backup due — triggering automatic export…');
    void this._handleExportRequest(agentId);
  }

  private _saveLastBackupTime(root: string): void {
    try {
      fs.writeFileSync(path.join(root, '.autodev', 'last_backup.json'), JSON.stringify({ ts: Date.now() }), 'utf8');
    } catch { /* ignore */ }
  }

  /** Dispatch a slash command received from any inbound channel. */
  private _handleCommand(cmd: string): void {
    const c = cmd.trim().toLowerCase();
    if (c === '/restart') {
      this._cb?.log('🔄 /restart received — restarting loop…');
      this._notifyDiscord('🔄 Restarting loop (/restart received)');
      void this.restart();
      return;
    }
    if (c === '/retry' || c === '/resume') {
      if (this._state === 'paused') {
        this._cb?.log(`▶️ ${c} received — resuming paused loop…`);
        this._notifyDiscord(`▶️ Resuming loop (\`${c}\` received)`);
        this.retry();
      } else {
        this._cb?.log(`▶️ ${c} received but loop is not paused (state=${this._state}) — ignoring.`);
      }
      return;
    }
    if (c === '/clear') {
      this._cb?.log('🗑 /clear received — clearing Claude session…');
      this._notifyDiscord('🗑 `/clear` received — clearing Claude session');
      const root = this._workspaceRoot;
      const provider = this._cb?.getActiveProvider() ?? '';
      if (root) {
        if (provider === 'claude-tui') {
          let sessionId = getSessionId(root, 'claude-tui');
          if (!sessionId) { sessionId = getClaudeTuiLatestSessionId(root); }
          if (sessionId) {
            runClaudeTuiClear(root, sessionId, msg => this._cb?.log(msg))
              .then(() => { clearSessionId(root, 'claude-tui'); this._cb?.log('🗑 /clear (TUI) complete'); })
              .catch(e => this._cb?.log(`⚠️ /clear (TUI) failed: ${e instanceof Error ? e.message : String(e)}`));
          } else {
            this._cb?.log('⚠️ /clear: no active Claude TUI session found');
          }
        } else {
          // Default to claude-cli
          let sessionId = getSessionId(root, 'claude-cli');
          if (!sessionId) { sessionId = findLatestClaudeSession(root); }
          if (sessionId) {
            runClaudeClear(sessionId, root, msg => this._cb?.log(msg))
              .then(() => { clearSessionId(root, 'claude-cli'); this._cb?.log('🗑 /clear complete'); })
              .catch(e => this._cb?.log(`⚠️ /clear failed: ${e instanceof Error ? e.message : String(e)}`));
          } else {
            this._cb?.log('⚠️ /clear: no active Claude session found');
          }
        }
      }
    }
  }

  /**
   * Handle an instant/steer message pushed over the WS. Unlike a normal task
   * (which is queued to TODO and picked up on the next poll), a steer is meant
   * to reach the agent *now*:
   *
   *   • claude-tui, mid-turn  → inject the text straight into the running turn
   *     (true mid-turn steering via the live stdin session).
   *   • otherwise (idle, or a provider without a live session) → append to TODO
   *     and wake the idle sleep so it runs at the very next turn boundary rather
   *     than waiting for a poll interval. This is the documented fallback.
   */
  private async _handleSteer(text: string, onDelivered?: () => void): Promise<void> {
    const clean = text.trim();
    // Malformed/empty steer: nothing to deliver — treat as terminally handled so
    // the server doesn't keep replaying it.
    if (!clean) { onDelivered?.(); return; }
    const root = this._workspaceRoot;
    const provider = this._cb?.getActiveProvider() ?? '';

    // True mid-turn injection — only claude-tui keeps a live steerable session,
    // and only while a turn is actually running. Await the injection: mark the
    // delivery seen ONLY after the stdin write resolves, so a write that rejects
    // (dead child / closed pipe) falls through to the durable TODO append below
    // instead of dropping the steer — preserving at-least-once delivery.
    // `_currentTask` is the authoritative "a turn is genuinely in flight" signal
    // — it is set for the whole duration of a dispatched turn and cleared while
    // idle-polling. A provider's own busy flag can go STALE (e.g. grok's turn-end
    // detector never fires and the loop force-unblocks via the exit-file sentinel,
    // leaving `_busyRoots` set). Without this guard a steer arriving while the loop
    // is IDLE would be injected into a pane with no running turn and marked
    // delivered, yet nothing would run until some *unrelated* later task happened
    // to start a turn (observed ~1.5 min stall, potentially indefinite). Gating on
    // `_currentTask` routes an idle steer to the buffer path below, which wakes the
    // idle sleep and drains it into a real turn immediately.
    const turnInFlight = !!this._currentTask;
    if (root && turnInFlight && provider === 'claude-tui' && isClaudeTuiBusy(root)) {
      if (await steerClaudeTui(root, clean, msg => this._cb?.log(msg))) {
        this._cb?.log(`⚡ Steered mid-turn: "${clean.slice(0, 80)}"`);
        onDelivered?.(); // durably injected into the live turn
        return;
      }
    }

    // copilot-sdk keeps a persistent LocalSession whose send(mode:'immediate')
    // injects into the running turn — true mid-turn steering, same as claude-tui.
    // (copilot-CLI is a one-shot subprocess with no live turn to inject into, so
    // it always falls through to the next-turn TODO queue below.)
    if (root && turnInFlight && provider === 'copilot-sdk' && isCopilotSdkBusy(root)) {
      if (await steerCopilotSdk(root, clean, msg => this._cb?.log(msg))) {
        this._cb?.log(`⚡ Steered mid-turn (copilot-sdk): "${clean.slice(0, 80)}"`);
        onDelivered?.();
        return;
      }
    }

    // opencode-sdk keeps a persistent in-process server + session; a prompt sent to
    // the live session mid-turn is picked up by the running turn (interrupt + continue).
    if (root && turnInFlight && provider === 'opencode-sdk' && isOpencodeSdkBusy(root)) {
      if (await steerOpencodeSdk(root, clean, msg => this._cb?.log(msg))) {
        this._cb?.log(`⚡ Steered mid-turn (opencode-sdk): "${clean.slice(0, 80)}"`);
        onDelivered?.();
        return;
      }
    }

    // grok-tui runs inside a persistent tmux PTY; keys sent to the live pane
    // mid-turn are folded into the running grok turn (true steering). Only when
    // a turn is actually in flight — steerGrokTui returns false otherwise so we
    // fall through to the durable TODO queue below (at-least-once).
    if (root && turnInFlight && provider === 'grok-tui' && isGrokTuiBusy(root)) {
      if (await steerGrokTui(root, clean, msg => this._cb?.log(msg))) {
        this._cb?.log(`⚡ Steered mid-turn (grok-tui): "${clean.slice(0, 80)}"`);
        onDelivered?.();
        return;
      }
    }

    // Fallback: the provider can't be steered mid-turn (grok-*/copilot-cli are
    // one-shot subprocesses). Do NOT append to TODO here — a provider that edits
    // TODO.md itself as it runs (grok manages its own checklist) would clobber a
    // task appended during its turn, silently losing the steer. Instead BUFFER it
    // and flush at the next turn boundary (see _drainPendingSteers), where no run
    // is active. onDelivered is fired only after the durable append there, so the
    // server keeps the steer for reconnect-replay until it's really in TODO.
    const todoPath = this._settings?.todoPath || (root ? path.join(root, 'TODO.md') : '');
    if (!todoPath) {
      this._cb?.log(`⚡ Steer dropped — no TODO path (text: "${clean.slice(0, 80)}")`);
      onDelivered?.();
      return;
    }
    // Dedup against a server reconnect-replay while it's still buffered.
    if (this._pendingSteers.some(s => s.text === clean)) { onDelivered?.(); return; }
    this._pendingSteers.push({ text: clean, onDelivered });
    this._cb?.log(`⚡ Steer queued for next turn boundary: "${clean.slice(0, 80)}"`);
    this._wakeIdleSleep();
  }

  /** Flush steers buffered during a run into TODO at a turn boundary (no active
   *  provider run), so a provider's own TODO rewrite can't clobber them. */
  private _pendingSteers: Array<{ text: string; onDelivered?: () => void }> = [];
  private async _drainPendingSteers(todoPath: string): Promise<void> {
    if (!this._pendingSteers.length) { return; }
    const batch = this._pendingSteers.splice(0, this._pendingSteers.length);
    for (const s of batch) {
      try {
        await todoWriter.append(todoPath, s.text, shortId());
        s.onDelivered?.(); // durably in TODO now — at-least-once satisfied
      } catch (err) {
        this._pendingSteers.push(s); // retry next boundary; do NOT ack
        this._cb?.log(`⚡ Steer append failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Build an EmailTaskPoller from the Email MCP entry's env block, or return
   * null if the feature is disabled or required IMAP creds are missing.
   */
  private _buildEmailPoller(settings: AutodevSettings): EmailTaskPoller | null {
    const root = this._workspaceRoot;
    const userMcp = root ? loadProjectUserMcp(root) : {};
    const entry = userMcp['zerolib-email'];
    const env = entry?.env ?? {};
    if (!entry) return null;
    if (String(env.AUTODEV_EMAIL_RECEIVE_TASKS).toLowerCase() !== 'true') return null;
    const host = env.MCP_EMAIL_SERVER_IMAP_HOST;
    const user = env.MCP_EMAIL_SERVER_USER_NAME || env.MCP_EMAIL_SERVER_EMAIL_ADDRESS;
    const pass = env.MCP_EMAIL_SERVER_PASSWORD;
    if (!host || !user || !pass) return null;
    const port = parseInt(env.MCP_EMAIL_SERVER_IMAP_PORT || '993', 10) || 993;
    const secure = String(env.MCP_EMAIL_SERVER_IMAP_SSL ?? 'true').toLowerCase() !== 'false';
    const verify = String(env.MCP_EMAIL_SERVER_IMAP_VERIFY_SSL ?? 'true').toLowerCase() !== 'false';
    const allowed = (env.AUTODEV_EMAIL_ALLOWED_SENDERS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    // Fail closed: an empty allowlist would otherwise ingest autonomous,
    // full-tool-access instructions from ANY sender who guesses the mailbox.
    // Require an explicit allowlist before enabling inbound email tasks.
    if (allowed.length === 0) {
      this._cb?.log('🔒 Inbound email tasks disabled — set AUTODEV_EMAIL_ALLOWED_SENDERS to an explicit sender allowlist to enable them.');
      return null;
    }
    // The allowlist matches the (spoofable) From header, so additionally require
    // the receiving MTA's DKIM/SPF verdict by default. An operator on a trusted
    // internal relay can opt out with AUTODEV_EMAIL_REQUIRE_AUTH=false, and pin
    // the trusted receiver with AUTODEV_EMAIL_AUTHSERV_ID.
    const requireAuth = String(env.AUTODEV_EMAIL_REQUIRE_AUTH ?? 'true').toLowerCase() !== 'false';
    const authServId = env.AUTODEV_EMAIL_AUTHSERV_ID || undefined;
    if (!requireAuth) {
      this._cb?.log('⚠️ Inbound email DKIM/SPF verification is OFF (AUTODEV_EMAIL_REQUIRE_AUTH=false) — From-header spoofing can trigger tasks. Only safe on a trusted relay.');
    }
    return new EmailTaskPoller({ host, port, secure, user, pass, allowedSenders: allowed, rejectUnauthorized: verify, requireAuth, authServId });
  }

  /**
   * Start Discord and webhook server pollers as independent setInterval loops.
   * They run continuously in the background — even while the AI is processing a task.
   */
  private _startPollers(todoPath: string): void {
    const POLL_MS = 3_000;

    if (this._discordPoller) {
      const discordInterval = setInterval(async () => {
        if (this._state !== 'running') { return; }
        try {
          const appended = await this._discordPoller!.pollAndAppend(todoPath, this._workspaceRoot ?? undefined);
          if (appended) { this._wakeIdleSleep(); }
        } catch { }
      }, POLL_MS);
      this._pollerIntervals.push(discordInterval);
    }

    if (this._webhookPoller) {
      const webhookInterval = setInterval(async () => {
        if (this._state !== 'running') { return; }
        try {
          const appended = await this._webhookPoller!.pollAndAppend(todoPath, this._workspaceRoot ?? undefined);
          if (appended) { this._wakeIdleSleep(); }
        } catch { }
      }, POLL_MS);
      this._pollerIntervals.push(webhookInterval);
    }

    if (this._emailPoller) {
      // IMAP servers throttle aggressive polling — every 10s is plenty.
      const emailInterval = setInterval(async () => {
        if (this._state !== 'running') { return; }
        try {
          const appended = await this._emailPoller!.pollAndAppend(todoPath, this._workspaceRoot ?? undefined);
          if (appended) { this._wakeIdleSleep(); }
        } catch { }
      }, 10_000);
      this._pollerIntervals.push(emailInterval);
    }

    // Poll <workspace>/.autodev/hooks-events.jsonl every 10s and forward new
    // lines via WS. Per-workspace, NOT homedir: two VS Code instances on the
    // same machine would otherwise both poll one shared file and each ship
    // every line under their own slug — making hooks from `tester-1` show
    // up as `A1` (and vice-versa) in pixel-office.
    if (this._webhookPoller?.isWebSocket && this._workspaceRoot) {
      const hooksJsonl = path.join(this._workspaceRoot, '.autodev', 'hooks-events.jsonl');

      // Start at current file size so we don't replay old events on loop restart
      try {
        this._hooksFileOffset = fs.existsSync(hooksJsonl)
          ? fs.statSync(hooksJsonl).size
          : 0;
      } catch { this._hooksFileOffset = 0; }

      // Dedupe window: any hook line byte-identical to one forwarded within
      // this many ms is dropped. Even with per-workspace sinks, parallel
      // copilot/claude processes inside the same workspace can write the
      // same payload several times in one second.
      const HOOKS_DEDUPE_WINDOW_MS = 30_000;

      const hooksInterval = setInterval(() => {
        if (this._state !== 'running') { return; }
        try {
          if (!fs.existsSync(hooksJsonl)) { return; }
          const size = fs.statSync(hooksJsonl).size;
          if (size <= this._hooksFileOffset) { return; }
          const fd = fs.openSync(hooksJsonl, 'r');
          const buf = Buffer.alloc(size - this._hooksFileOffset);
          fs.readSync(fd, buf, 0, buf.length, this._hooksFileOffset);
          fs.closeSync(fd);
          this._hooksFileOffset = size;
          const sessionName = (this._settings?.sessionName && this._settings.sessionName.trim())
            || (this._workspaceRoot ? path.basename(this._workspaceRoot) : undefined);
          const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
          // Prune dedupe map of stale entries before this tick's run
          const now = Date.now();
          for (const [hash, ts] of this._hookLineSeen) {
            if (now - ts > HOOKS_DEDUPE_WINDOW_MS) { this._hookLineSeen.delete(hash); }
          }
          for (const line of lines) {
            const hash = crypto.createHash('sha1').update(line).digest('hex');
            const seenAt = this._hookLineSeen.get(hash);
            if (seenAt !== undefined && now - seenAt <= HOOKS_DEDUPE_WINDOW_MS) {
              // Byte-identical hook within the window — drop silently. Distinct
              // tool invocations have at least one differing byte (timestamp,
              // tool input args, runId) and survive this check.
              continue;
            }
            this._hookLineSeen.set(hash, now);
            try {
              const ev = JSON.parse(line);
              // Inject session name (workspace folder) so pixel office can display it
              if (sessionName) { ev._session_name = sessionName; }
              this._webhookPoller!.sendFrame({ type: 'hook_event', data: ev });
            } catch { /* skip malformed lines */ }
          }
        } catch { /* ignore read errors */ }
      }, 10_000);
      this._pollerIntervals.push(hooksInterval);
    }
  }

  /**
   * Run `cozempic init` in the given project directory if:
   *  1. `cozempic` is on the PATH (or login-shell PATH on Unix)
   *  2. The project hasn't been initialised yet
   *     (`.claude/settings.local.json` does not contain a cozempic hook entry)
   *
   * Runs synchronously in a background thread-pool task (spawnSync) so it
   * doesn't block the VS Code event loop but still logs completion.
   */
  private _runCozempicInit(workspaceRoot: string, log: (msg: string) => void): void {
    try {
      // Detect whether cozempic hooks are already wired for this project.
      // `cozempic init` writes its hooks into .claude/settings.local.json.
      const localSettingsPath = path.join(workspaceRoot, '.claude', 'settings.local.json');
      if (fs.existsSync(localSettingsPath)) {
        const content = fs.readFileSync(localSettingsPath, 'utf8');
        if (content.includes('cozempic')) {
          // Already initialised — skip silently.
          return;
        }
      }

      // Resolve cozempic binary (VS Code's process.env.PATH may not include
      // ~/.local/bin where pipx/pip installs it, so try a login shell on Unix).
      const isWin = process.platform === 'win32';
      // Disable telemetry and auto-update pings for all cozempic invocations.
      const cozempicEnv = { ...process.env, COZEMPIC_NO_TELEMETRY: '1', COZEMPIC_NO_AUTO_UPDATE: '1' };
      let cozempicAvailable = false;
      try {
        if (isWin) {
          execSync('cozempic --version', { stdio: 'pipe', cwd: workspaceRoot, env: cozempicEnv });
        } else {
          const shell = process.env.SHELL || 'bash';
          execSync(`${shell} -lc "cozempic --version"`, { stdio: 'pipe', cwd: workspaceRoot, env: cozempicEnv });
        }
        cozempicAvailable = true;
      } catch { /* not installed — skip */ }

      if (!cozempicAvailable) { return; }

      log('🧹 Running cozempic init for this project…');
      if (isWin) {
        execSync('cozempic init', { stdio: 'pipe', cwd: workspaceRoot, env: cozempicEnv });
      } else {
        const shell = process.env.SHELL || 'bash';
        execSync(`${shell} -lc "cozempic init"`, { stdio: 'pipe', cwd: workspaceRoot, env: cozempicEnv });
      }
      log('🧹 cozempic init complete — guard daemon and pruning hooks wired');
    } catch (err) {
      // Non-fatal — cozempic is optional.
      const msg = err instanceof Error ? err.message : String(err);
      log(`⚠️ cozempic init failed (non-fatal): ${msg}`);
    }
  }

  private _stopPollers(): void {
    for (const id of this._pollerIntervals) { clearInterval(id); }
    this._pollerIntervals = [];
    // Tear down any persistent WebSocket connection
    if (this._webhookPoller) { this._webhookPoller.destroy(); }
  }

  private async _runLoop(todoPath: string, settings: AutodevSettings): Promise<void> {
    let allTasksDoneNotified = false;

    // Reset any [~] in-progress tasks left over from a previous run
    if (settings.autoResetPendingTasks) {
      await todoWriter.resetAllInProgress(todoPath);
      this._cb?.log('Auto-reset in-progress tasks to [ ]');
    }

    while (this._state === 'running') {
      // --- Restore main provider after fallback period ends ---
      if (this._mainProviderBeforeFallback && this._mainProviderResumeAt &&
          Date.now() >= this._mainProviderResumeAt.getTime()) {
        const main = this._mainProviderBeforeFallback;
        this._mainProviderBeforeFallback = null;
        this._mainProviderResumeAt = undefined;
        this._resumeAt = undefined;
        this._cb?.log(`↩ Rate limit period ended — switching back to ${main}`);
        this._notifyDiscord(`↩ Rate limit period ended — switching back to **${main}**`);
        this._cb?.setActiveProvider?.(main);
      }

      // Turn boundary: flush any steers buffered mid-run into TODO now, while no
      // provider run is active. Appending here (not during the run) is what makes
      // it survive — a provider like grok rewrites TODO.md itself as it works, and
      // a task appended during its turn gets clobbered by that rewrite.
      await this._drainPendingSteers(todoPath);

      const tasks = parseTodo(todoPath);
      let task = pickNextTask(tasks); // first [ ] task

      // Helper: is the CLI process still running? (exit file absent or empty)
      // On the very first dispatch (_iterations === 0) no process has been launched yet,
      // so always return false regardless of file state.
      const provider = this._cb?.getActiveProvider();
      const cliIsRunning = (() => {
        if (this._iterations === 0) { return false; } // nothing launched yet
        if (!this._workspaceRoot || !provider || !PROVIDERS[provider]?.isCli) { return false; }
        // claude-tui: the exit file is per-message and gets a sentinel when the
        // turn takes >30 s to finish.  Instead, use the in-flight turn flag which
        // stays true for the entire duration of the async, including after
        // _waitForTaskCompletion resolves but before the turn emits 'result'.
        if (provider === 'claude-tui') {
          return isClaudeTuiBusy(this._workspaceRoot);
        }
        if (provider === 'copilot-sdk') {
          return isCopilotSdkBusy(this._workspaceRoot);
        }
        if (provider === 'opencode-sdk') {
          return isOpencodeSdkBusy(this._workspaceRoot);
        }
        // opencode-cli may run on a remote machine (not launched by this extension).
        // The JSONL hooks file is the authoritative source of truth: if the last
        // event is a terminal Stop/StopFailure/SessionEnd (or the file is stale),
        // treat the process as NOT running — regardless of the exit file.
        // This prevents the exit-file `catch { return true }` fallback from
        // incorrectly reporting "still running" when the file simply doesn't exist
        // (remote session never wrote one), causing [~] tasks to be stuck forever.
        if (provider === 'opencode-cli') {
          // If the exit file from the last dispatch is non-empty, the process has
          // definitely exited — don't block waiting for the hooks-file staleness
          // window. The hooks Stop event may lag behind the bash echo due to async
          // I/O ordering inside the opencode process, causing a race where
          // isOpenCodeCliActive() returns true even after the process has exited.
          // Checking the exit file first avoids a ~90 s stall between tasks.
          try {
            const xfContent = fs.readFileSync(exitFilePath(this._workspaceRoot, provider), 'utf8').trim();
            if (xfContent !== '') { return false; } // process wrote exit code → done
          } catch { /* no exit file yet — fall through to hooks check */ }
          const ocSid = getSessionId(this._workspaceRoot, 'opencode-cli');
          // 5-minute staleness window (was 90 s). The exit-file check above is the
          // authoritative "done" signal for locally-launched runs, so this only
          // bridges gaps DURING an active run — e.g. a long LLM generation phase
          // between tool.execute events. A 90 s window flipped the agent to IDLE
          // mid-run (and tripped the premature-completion watchdog) whenever a
          // single turn ran longer than that without emitting an intermediate hook.
          return isOpenCodeCliActive(this._workspaceRoot, 300_000, ocSid);
        }
        try {
          const content = fs.readFileSync(exitFilePath(this._workspaceRoot, provider), 'utf8').trim();
          return content === ''; // empty = process still running (exit code not yet written)
        } catch { return true; } // file absent = still running
      })();

      // If no [ ] task but CLI is still running and there's a [~] task in flight,
      // treat that [~] task as the current one and wait — don't interrupt the process.
      let watchingInProgress = false;
      if (!task && cliIsRunning) {
        const inProgress = tasks.find(t => t.status === 'in-progress');
        if (inProgress) {
          task = inProgress;
          watchingInProgress = true;
          this._cb?.log(`⏳ CLI running, watching in-progress: ${discordLabel(task.text)}`);
        }
      }

      if (!task) {
        const remaining = countRemaining(tasks);
        if (remaining === 0) {
          if (!allTasksDoneNotified) {
            allTasksDoneNotified = true;
            this._idleNotified = true;
            this._cb?.log('All tasks completed ✓ — polling for new tasks…');
            this._notifyWebhook('all_tasks_done', {
              workDir:   this._workspaceRoot,
              gitRepo:   this._gitRepo,
              gitBranch: this._gitBranch,
            });
            // Explicit idle state — server flips badge to 'idle' on this signal.
            this._notifyWebhook('agent_idle', {
              workDir:   this._workspaceRoot,
              gitRepo:   this._gitRepo,
              gitBranch: this._gitBranch,
            });
            this._notifyDiscord('✅ All tasks done — waiting for more…');
            // Notify once-mode callers (e.g. `autodev start --once`) so they can
            // stop instead of idle-polling forever.
            this._cb?.onAllTasksDone?.();
          }
        } else {
          // There are uncompleted tasks but none are pending (e.g. all [~] in-progress).
          // If the CLI isn't running, those [~] tasks are stranded — the AI
          // marked them in-progress but never came back to finish them. Reset
          // them to [ ] so the next iteration picks them up instead of idling
          // forever.
          //
          // Exception: if opencode-cli exited cleanly (Stop event present), the
          // [~] task was intentionally left in-progress while waiting for an
          // external response (e.g. waiting for an email from another agent).
          // In that case we must NOT reset — just wait; the email/webhook
          // pollers will add new [ ] tasks when the response arrives, which
          // will trigger a fresh opencode dispatch that also resolves the [~].
          if (!cliIsRunning) {
            const cleanExit = provider === 'opencode-cli' &&
              openCodeExitedCleanly(this._workspaceRoot ?? '', getSessionId(this._workspaceRoot ?? '', 'opencode-cli'));
            if (cleanExit) {
              this._cb?.log(`⏳ opencode-cli exited cleanly with [~] task — waiting for external response…`);
            } else {
              // Exclude tasks flagged as provider hard-failures: those were left
              // [~] ON PURPOSE to signal "blocked / needs attention". Auto-marking
              // them done here would re-introduce the exact false-green we fixed.
              const stranded = tasks.filter(t =>
                t.status === 'in-progress' && !this._blockedTasks.has(t.id ?? t.text));
              for (const t of stranded) {
                // Auto-mark as [x] done rather than resetting to [ ].
                // Resetting to [ ] causes an infinite loop: the agent picks it
                // up, marks [~] again, exits, and we end up here forever.
                // If the CLI exited leaving a [~] task it means the agent
                // already worked on it — treat it as done.
                await todoWriter.markDone(todoPath, t).catch(() => {});
              }
              if (stranded.length > 0) {
                this._cb?.log(`✅ Auto-marked ${stranded.length} stranded [~] task(s) as done — CLI exited without completing them`);
                continue; // re-pick immediately
              }
            }
          }
          this._cb?.log(`No pending tasks — waiting ${settings.loopInterval}s…`);
        }
        // Clear any stale current-task label and refresh the sidebar so the
        // counter reflects the just-finalised TODO.md (otherwise it can sit on
        // the pre-final-cycle "N left" until something else triggers a push).
        this._currentTask = undefined;
        this._setState('running');
        // Keep polling forever — never stop automatically.
        // _sleepOrWake() resolves early if a poller appends a task mid-sleep.
        await this._sleepOrWake(settings.loopInterval * 1000);
        continue;
      }

      // A task is available — reset the all-done flag
      allTasksDoneNotified = false;

      if (!watchingInProgress) {
        this._iterations++;
        // Track how many times we've dispatched this specific task.
        // If the agent hasn't marked it done after 3 attempts, force-mark it
        // ourselves and move on so the queue doesn't get stuck.
        const taskKey = task.id ?? task.text;
        // A fresh [ ] dispatch means this task is being retried — the provider
        // has presumably recovered, so clear any prior hard-failure flag and let
        // it complete (or fail) honestly on its own merits this time.
        this._blockedTasks.delete(taskKey);
        const attempts = (this._taskAttempts.get(taskKey) ?? 0) + 1;
        this._taskAttempts.set(taskKey, attempts);
        const maxAttempts = settings.maxTaskAttempts ?? 3;
        if (attempts > maxAttempts) {
          this._taskAttempts.delete(taskKey);
          this._cb?.log(`⚠️ Task not marked done after ${maxAttempts} attempt(s) — force-marking complete: ${task.text}`);
          this._notifyDiscord(`⚠️ Task force-marked done after ${maxAttempts} failed attempt(s):\n${task.text}`);
          await todoWriter.markDone(todoPath, task).catch(() => {});
          this._completedCount++;
          continue;
        }
        if (attempts > 1) {
          this._cb?.log(`🔍 Retrying task (attempt ${attempts}/${maxAttempts}): ${task.text}`);
        }
      }
      // Detect first pickup of a watchingInProgress task (OpenCode was already
      // running when this iteration started). We need to send task_start so
      // Pixel Office flips from idle → active — but only once per task, not on
      // every polling iteration while the process is still running.
      const isNewWatchedTask = watchingInProgress && this._currentTask !== task.text;
      this._currentTask = task.text;
      this._setState('running', task.text);

      // Decide whether to include the full profile in this dispatch.
      // Always include on first task; also re-include every profileEveryNTasks if set.
      const profileInterval = settings.profileEveryNTasks ?? 0;
      const includeProfile = this._iterations === 1
        || (profileInterval > 0 && this._profileSentCounter >= profileInterval);
      if (includeProfile) { this._profileSentCounter = 0; }
      this._profileSentCounter++;

      // Build prompt (needed even when not sending, for messageFile path)
      const { prompt, messageFile } = buildPrompt(task, this._workspaceRoot!, path.dirname(todoPath), includeProfile);
      const remaining = countRemaining(parseTodo(todoPath));

      if (!watchingInProgress) {
        this._cb?.log(`▶ Task [${this._iterations}]: ${task.text}`);
        this._idleNotified = false;
        this._notifyWebhook('task_start', {
          iteration: this._iterations,
          task:      { text: task.text, id: task.id },
          remaining,
          workDir:   this._workspaceRoot,
          gitRepo:   this._gitRepo,
          gitBranch: this._gitBranch,
        });
        this._notifyDiscord(`▶️ **Task started** (${remaining} remaining):\n${discordLabel(task.text)}`);
      } else if (isNewWatchedTask) {
        // CLI was already running when this task was first detected — send task_start
        // so Pixel Office flips from idle → active (it never saw the original start).
        this._cb?.log(`⏳ Watching in-progress task: ${task.text}`);
        this._idleNotified = false;
        this._notifyWebhook('task_start', {
          iteration: this._iterations,
          task:      { text: task.text, id: task.id },
          remaining,
          workDir:   this._workspaceRoot,
          gitRepo:   this._gitRepo,
          gitBranch: this._gitBranch,
        });
      }

      const taskStartTime = Date.now();
      // Snapshot the JSONL cursor before sending — we only read bytes written after this
      const claudeCursor = getClaudeSessionCursor(this._workspaceRoot!);

      try {
        if (cliIsRunning || watchingInProgress) {
          this._cb?.log(`⏳ CLI still running — skipping send, waiting for task completion…`);
        } else {
          // Send to AI — resolves as soon as the prompt is pasted, not when Claude finishes
          await this._cb!.sendToAi(prompt, task.text, includeProfile, messageFile);
        }

        // Wait for the AI to mark the task [x] done in TODO.md
        await this._waitForTaskCompletion(todoPath, task, claudeCursor);

        // Wait for the CLI process to fully exit before reading its stdout.
        // The exit-code file is written only after the shell command completes,
        // so a non-empty file guarantees the stdout file is fully flushed.
        const activeProvider = this._cb?.getActiveProvider();
        if (this._workspaceRoot && activeProvider === 'claude-tui') {
          // claude-tui: _waitForTaskCompletion resolves as soon as the task is
          // marked [x] in TODO.md, but the persistent async turn may still be
          // running (Claude executing further tool calls, marking other tasks [~],
          // etc.).  Wait for the busy flag to clear — written at the very end of
          // the fire-and-forget async after 'result' fires — so we don't
          // prematurely proceed while the client is still mid-turn.
          //
          // Use activity-based deadline: reset the 10-minute window whenever a
          // new streaming event arrives so we never cut off an active turn early.
          // Only time out after 10 consecutive minutes of no streaming activity.
          const INACTIVITY_MS = 10 * 60_000;
          let lastSeenActivity = getClaudeTuiLastActivity(this._workspaceRoot);
          let tuiDeadline = Date.now() + INACTIVITY_MS;
          while (isClaudeTuiBusy(this._workspaceRoot) && Date.now() < tuiDeadline) {
            if (this._state !== 'running') { break; }
            await this._sleepAbortable(500);
            // Reset deadline if new activity arrived since last check.
            const nowActivity = getClaudeTuiLastActivity(this._workspaceRoot);
            if (nowActivity > lastSeenActivity) {
              lastSeenActivity = nowActivity;
              tuiDeadline = Date.now() + INACTIVITY_MS;
            }
          }
          if (isClaudeTuiBusy(this._workspaceRoot)) {
            this._cb?.log('⚠️ Claude TUI turn: no streaming activity for 10 minutes — force-clearing busy state and moving on');
            forceIdleClaudeTui(this._workspaceRoot);
          }
        } else if (this._workspaceRoot && activeProvider === 'copilot-sdk') {
          const tuiDeadline = Date.now() + 10 * 60_000;
          while (isCopilotSdkBusy(this._workspaceRoot) && Date.now() < tuiDeadline) {
            if (this._state !== 'running') { break; }
            await this._sleepAbortable(500);
          }
          if (isCopilotSdkBusy(this._workspaceRoot)) {
            this._cb?.log('⚠️ Copilot TUI turn did not complete within 10 minutes — moving on');
          }
        } else if (this._workspaceRoot && activeProvider === 'opencode-sdk') {
          // opencode-sdk: same pattern as claude-tui — wait for the in-flight
          // fire-and-forget async to fully complete (session.idle received).
          // Use activity-based deadline: reset the 30-minute window on each tool
          // activity change so long-running tasks are never prematurely cut off.
          const INACTIVITY_MS_SDK = 30 * 60_000;
          let sdkDeadline = Date.now() + INACTIVITY_MS_SDK;
          let lastActivity: string | undefined;
          while (isOpencodeSdkBusy(this._workspaceRoot) && Date.now() < sdkDeadline) {
            if (this._state !== 'running') { break; }
            // Escape hatch: if hooks-events.jsonl shows server was disposed but
            // the SDK async never got the event (e.g. stream closed before we
            // could read it), force-clear the busy flag so we don’t wait forever.
            const sdkSid = getOpencodeSdkLatestSessionId(this._workspaceRoot);
            if (openCodeExitedCleanly(this._workspaceRoot, sdkSid)) {
              this._cb?.log('⚠️ OpenCode SDK: server disposed detected via hooks — force-clearing busy state');
              forceIdleOpencodeSdk(this._workspaceRoot);
              break;
            }
            // Forward tool activity changes to the sidebar; reset inactivity deadline.
            const act = getOpencodeSdkActivity(this._workspaceRoot);
            if (act !== lastActivity) {
              lastActivity = act;
              this._cb?.onActivityChange?.(act);
              sdkDeadline = Date.now() + INACTIVITY_MS_SDK;
            }
            await this._sleepAbortable(500);
          }
          if (lastActivity !== undefined) { this._cb?.onActivityChange?.(undefined); }
          if (isOpencodeSdkBusy(this._workspaceRoot)) {
            this._cb?.log('⚠️ OpenCode SDK turn: no activity for 30 minutes — force-clearing busy state and moving on');
            forceIdleOpencodeSdk(this._workspaceRoot);
          }
        } else if (this._workspaceRoot && activeProvider && PROVIDERS[activeProvider]?.isCli) {
          const exitFile = exitFilePath(this._workspaceRoot, activeProvider);
          // Do NOT clear the file here. Each dispatch allocates a fresh
          // per-message exit file via newMessageOutput(), so the value we see
          // is the one the CLI just wrote. Clearing it would leave it empty
          // forever (no CLI is running to re-write it) and the NEXT iteration's
          // cliIsRunning probe would then incorrectly conclude "CLI still
          // running" — pinning the loop on a task that was never dispatched.
          const isReady = (): boolean => {
            try { return fs.readFileSync(exitFile, 'utf8').trim().length > 0; }
            catch { return false; }
          };
          if (!isReady()) {
            // Poll up to 30 s for the exit file to become non-empty
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              await this._sleepAbortable(500);
              if (this._state !== 'running') { break; }
              if (isReady()) { break; }
            }
            // If still empty after the wait, write a sentinel so the next
            // iteration's cliIsRunning probe doesn't read an empty file and
            // wrongly conclude "CLI still running". The shell may have failed
            // to run the trailing `echo $? > exitFile` (terminal killed,
            // bundle aborted, etc.) — but the task is done and we're moving on.
            if (!isReady()) {
              try { fs.writeFileSync(exitFile, 'unknown\n', 'utf8'); } catch { /* ignore */ }
              this._cb?.log('⚠️ CLI exit file never written — wrote sentinel to unblock next cycle');
              // grok-tui tracks turn-in-flight via an in-memory busy flag that is
              // cleared in the turn's finish(). If finish() never ran (the exit
              // file was never written), that flag stays STALE-TRUE and would make
              // a later idle steer be pane-injected instead of buffered. Force it
              // idle here so isGrokTuiBusy() stays honest.
              if (activeProvider === 'grok-tui') { forceIdleGrokTui(this._workspaceRoot); }
            }
          }
        } else {
          // Non-CLI providers: just wait for OS flush
          await this._sleepAbortable(2_000);
        }

        // Capture and persist CLI session ID so the next task can resume it
        if (this._workspaceRoot && activeProvider && PROVIDERS[activeProvider]?.isCli) {
          if (activeProvider === 'opencode-cli') {
            // Prefer the session ID from hooks events (fast, no subprocess);
            // fall back to `opencode session list` if hooks haven't fired yet.
            // Pass taskStartTime so we ignore stale/foreign hooks events from
            // before this dispatch (prevents cross-folder contamination).
            const hooksSid = getOpenCodeSessionIdFromHooks(this._workspaceRoot, taskStartTime);
            if (hooksSid) {
              saveSessionId(this._workspaceRoot, 'opencode-cli', hooksSid);
              this._cb?.log(`OpenCode session ID from hooks: ${hooksSid}`);
            } else {
              getLatestOpenCodeSessionId(this._workspaceRoot, msg => this._cb?.log(msg))
                .then(id => { if (id && this._workspaceRoot) { saveSessionId(this._workspaceRoot, 'opencode-cli', id); } })
                .catch(() => {});
            }
          } else if (activeProvider === 'claude-tui') {
            const sid = getClaudeTuiLatestSessionId(this._workspaceRoot);
            if (sid) { saveSessionId(this._workspaceRoot, 'claude-tui', sid); }
          } else if (activeProvider === 'copilot-sdk') {
            const sid = getLatestCopilotSdkSessionId(this._workspaceRoot);
            if (sid) { saveSessionId(this._workspaceRoot, 'copilot-sdk', sid); }
          } else if (activeProvider === 'opencode-sdk') {
            const sid = getOpencodeSdkLatestSessionId(this._workspaceRoot);
            if (sid) { saveSessionId(this._workspaceRoot, 'opencode-sdk', sid); }
          } else {
            const jsonlFallback = activeProvider === 'claude-cli'
              ? findLatestClaudeSession(this._workspaceRoot)
              : undefined;
            captureAndSaveSessionId(this._workspaceRoot, activeProvider, jsonlFallback);
            // Apply the configured display name to the now-known claude session
            // (the --resume picker label lives in ~/.claude/history.jsonl).
            if (activeProvider === 'claude-cli' && jsonlFallback && this._settings?.sessionName) {
              setClaudeSessionName(jsonlFallback, this._settings.sessionName, this._workspaceRoot);
            }
          }
          this._cb?.log(`Session ID captured for ${activeProvider}`);
        }

        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        this._completedCount++;
        this._autoCompactCounter++;
        this._resetSessionCounter++;
        this._periodicMgr.increment(this._iterations, this._workspaceRoot);
        this._compactedTaskLines.delete(task.line); // allow compact again if task re-appears
        this._taskAttempts.delete(task.id ?? task.text); // task done — reset attempt counter
        const afterTasks = parseTodo(todoPath);
        const afterRemaining = countRemaining(afterTasks);
        const totalKnown = this._iterations + afterRemaining;

        // Read the AI's output — prefer clean JSONL assistant text (no tool noise),
        // fall back to the tail of the raw stdout file.
        let taskOutput = '';
        if (this._workspaceRoot && (activeProvider === 'claude-cli' || activeProvider === 'claude-tui')) {
          // Primary: clean assistant-only text extracted from the JSONL session file.
          // Works for both claude-cli and claude-tui — both write the same JSONL format.
          // For claude-tui this replaces the noisy partial-chunk Discord stream with
          // one clean summary sent at task completion.
          taskOutput = readClaudeOutputSince(this._workspaceRoot, claudeCursor);
        } else if (this._workspaceRoot && activeProvider === 'copilot-sdk') {
          // copilot-sdk: read from the per-message stdoutFile (absolute path stored
          // at pointer file location in the .autodev directory).
          const outFile = stdoutFilePath(this._workspaceRoot, 'copilot-sdk');
          taskOutput = readCopilotSdkOutputSince(outFile, 0);
        }
        if (!taskOutput && this._workspaceRoot && activeProvider && PROVIDERS[activeProvider]?.isCli) {
          // Fallback: raw stdout file — take only the last 4 KB to avoid huge payloads.
          const outFile = stdoutFilePath(this._workspaceRoot, activeProvider);
          try {
            if (fs.existsSync(outFile)) {
              const raw = readOutputFile(outFile);
              // Strip ANSI escape codes and take the tail (the meaningful summary is at the end)
              const clean = raw.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\r/g, '');
              taskOutput = clean.length > 4000 ? '…' + clean.slice(-4000) : clean;
            }
          } catch { /* ignore */ }
        }

        this._cb?.log(`\u2705 Task done: ${task.text}`);
        this._notifyWebhook('task_done', {
          iteration: this._iterations,
          task:      { text: task.text, id: task.id },
          output:    taskOutput || undefined,
          duration,
          workDir:   this._workspaceRoot,
          gitRepo:   this._gitRepo,
          gitBranch: this._gitBranch,
        });
        const discordOutput = taskOutput
          ? `\n\`\`\`\n${taskOutput.slice(0, 1800)}\n\`\`\``
          : '';
        this._notifyDiscord(`\u2705 **Task done** (${afterRemaining} remaining):\n${discordLabel(task.text)}${discordOutput}`);
        if (afterRemaining > 0) {
          this._notifyDiscord(`\ud83d\udcca Progress: ${this._iterations}/${totalKnown}`);
          this._notifyWebhook('task_progress', {
            iteration: this._iterations,
            total:     totalKnown,
            remaining: afterRemaining,
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
        }

        // --- Auto-compact: run /compact every N completed tasks -----------
        // Skip the legacy autoCompact mechanism when compactEveryNTasks is set —
        // the new periodic-action system handles it and they must not both fire.
        const compactInterval = settings.autoCompactInterval ?? 5;
        if (settings.autoCompact && !(settings.compactEveryNTasks > 0) && this._autoCompactCounter >= compactInterval) {
          this._autoCompactCounter = 0;
          const acProvider = this._cb?.getActiveProvider() ?? '';
          this._cb?.log(`🗜 Auto-compact triggered after ${compactInterval} tasks (provider: ${acProvider})`);
          this._notifyDiscord(`🗜 Auto-compact triggered after ${compactInterval} tasks`);
          try {
            if (acProvider === 'claude-cli') {
              let sid = getSessionId(this._workspaceRoot!, 'claude-cli');
              if (!sid) { sid = findLatestClaudeSession(this._workspaceRoot!); }
              if (sid) {
                await runClaudeCompact(sid, this._workspaceRoot!, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Auto-compact complete');
              } else {
                this._cb?.log('⚠️ Auto-compact: no Claude session ID found — skipping');
              }
            } else if (acProvider === 'claude-tui') {
              let sid = getSessionId(this._workspaceRoot!, 'claude-tui');
              if (!sid) { sid = getClaudeTuiLatestSessionId(this._workspaceRoot!); }
              if (sid) {
                await runClaudeTuiCompact(this._workspaceRoot!, sid, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Auto-compact complete');
              } else {
                this._cb?.log('⚠️ Auto-compact: no Claude TUI session ID found — skipping');
              }
            } else if (acProvider === 'copilot-sdk') {
              this._cb?.log('ℹ️ Auto-compact not supported for copilot-sdk — skipping');
            } else if (acProvider === 'opencode-cli') {
              let sid = getSessionId(this._workspaceRoot!, 'opencode-cli');
              if (!sid) { sid = await getLatestOpenCodeSessionId(this._workspaceRoot!, msg => this._cb?.log(msg)); }
              if (sid) {
                await runOpenCodeCompact(sid, this._workspaceRoot!, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Auto-compact complete');
              } else {
                this._cb?.log('⚠️ Auto-compact: no OpenCode session ID found — skipping');
              }
            } else if (acProvider === 'opencode-sdk') {
              await runOpencodeSdkCompact(this._workspaceRoot!, msg => this._cb?.log(msg));
              this._cb?.log('🗜 Auto-compact complete (opencode-sdk)');
            }
          } catch (compactErr) {
            const cm = compactErr instanceof Error ? compactErr.message : String(compactErr);
            this._cb?.log(`⚠️ Auto-compact failed (non-fatal): ${cm}`);
          }
        }

        // --- Session reset: clear session every N completed tasks ---------
        const resetInterval = settings.resetSessionEveryNTurns ?? 0;
        if (settings.resumeSession && resetInterval > 0 && this._resetSessionCounter >= resetInterval) {
          this._resetSessionCounter = 0;
          const rsProvider = this._cb?.getActiveProvider() ?? '';
          this._cb?.log(`🔄 Session reset triggered after ${resetInterval} tasks (provider: ${rsProvider})`);
          this._notifyDiscord(`🔄 Session reset after ${resetInterval} tasks — summarising and starting fresh`);
          // Ask the agent to write a summary before the session is cleared
          try {
            const summaryMsg = `Before this session ends, please summarise everything accomplished so far into a file called SUMMARY.md in the project root. Include: tasks completed, key decisions made, any issues found, and current project state. Write comprehensively so the next session can continue without context loss. Then stop — do not pick up any new tasks.`;
            const summaryFile = writeMessageFile(this._workspaceRoot!, summaryMsg);
            await this._cb!.sendToAi(summaryMsg, 'session-summary', false, summaryFile);
          } catch (rsErr) {
            const rm = rsErr instanceof Error ? rsErr.message : String(rsErr);
            this._cb?.log(`⚠️ Session reset summary failed (non-fatal): ${rm}`);
          }
          // Clear the session ID so the next dispatch starts a fresh session
          if (this._workspaceRoot && rsProvider) {
            clearSessionId(this._workspaceRoot, rsProvider as import('./providers').ProviderId);
            this._cb?.log(`🔄 Session ID cleared — next task will start a new session`);
          }
        }

        // --- Periodic actions: compact / pruneTodo / skill / memory / summary / etc. --
        for (const action of this._periodicMgr.getDue(settings)) {
          this._periodicMgr.markHandled(action.id, this._iterations, this._workspaceRoot);
          this._cb?.log(`${action.icon} Periodic action '${action.id}' triggered`);
          this._notifyDiscord(`${action.icon} Periodic action: ${action.label}`);
          try {
            if (action.type === 'compact') {
              // Guard: time-based throttle — minimum 2 minutes between compacts
              const MIN_COMPACT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
              const timeSinceLastCompact = Date.now() - this._lastCompactTime;
              if (timeSinceLastCompact < MIN_COMPACT_INTERVAL_MS) {
                const waitSec = Math.ceil((MIN_COMPACT_INTERVAL_MS - timeSinceLastCompact) / 1000);
                this._cb?.log(`⚠️ Auto-compact throttled: wait ${waitSec}s (minimum 2min between compacts)`);
              } else {
                const acProvider = this._cb?.getActiveProvider() ?? '';
                if (acProvider && this._workspaceRoot) {
                  await this.compact(this._workspaceRoot, acProvider as ProviderId);
                } else {
                  this._cb?.log(`⚠️ Periodic compact: no active provider`);
                }
              }
            } else if (action.type === 'pruneTodo') {
              if (this._workspaceRoot) {
                const pruned = pruneTodoToArchive(todoPath, this._workspaceRoot);
                if (pruned > 0) {
                  this._cb?.log(`🧹 Pruned ${pruned} completed task(s) from TODO.md → DONE.md`);
                  this._notifyDiscord(`🧹 Pruned ${pruned} completed task(s) from TODO.md → DONE.md`);
                } else {
                  this._cb?.log(`🧹 Prune TODO: no completed tasks to move`);
                }
              }
            } else {
              const msgFile = writeMessageFile(this._workspaceRoot!, action.prompt);
              await this._cb!.sendToAi(action.prompt, action.id, false, msgFile);
            }
          } catch (paErr) {
            const pm = paErr instanceof Error ? paErr.message : String(paErr);
            this._cb?.log(`⚠️ Periodic action '${action.id}' failed (non-fatal): ${pm}`);
          }
        }
      } catch (err) {
        // --- Auth required: pause INDEFINITELY, never mark the task done ----
        // A logged-out / out-of-credit CLI is not a task failure. Put the task
        // back to [ ], flip the office to a distinct 'needs reauth' state, and
        // block until the operator re-authenticates and clicks Retry.
        if (err instanceof AuthError) {
          const rawMsg = err.rawMessage.slice(0, 300);
          const currentProvider = this._cb?.getActiveProvider() ?? 'unknown';
          this._cb?.log(`🔑 Authentication required (${currentProvider}) — pausing loop until re-auth. ${rawMsg}`);
          this._notifyDiscord(`🔑 **Authentication required** (${currentProvider}) — loop paused until you re-authenticate.\n\`\`\`\n${rawMsg}\n\`\`\``);
          this._notifyWebhook('reauth_required', {
            iteration: this._iterations,
            task:      { text: task.text, id: task.id },
            message:   rawMsg,
            provider:  currentProvider,
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
          // Also record it in the LOCAL hooks-events.jsonl. The webhook reaches the
          // office, but an EXTERNAL monitor (the desktop app watching a loop it did
          // not spawn, so it has no stdout) can only learn the loop paused for auth
          // from this file — without it the app shows a stale 'working'. Cleared by
          // the next task_start hook on resume.
          if (this._workspaceRoot) {
            appendHookEventLine(this._workspaceRoot, {
              hook_event_name: 'reauth_required', event_type: 'reauth_required',
              provider: currentProvider, cwd: this._workspaceRoot, message: rawMsg,
              title: 'Authentication required', tool_name: '', timestamp: new Date().toISOString(),
            });
          }
          // Never markDone — restore the task so it is retried after re-auth.
          await todoWriter.resetToTodo(todoPath, task).catch(() => {});
          // Evict the cached persistent provider process. claude-tui / opencode-sdk
          // / copilot-sdk cache one live process per root that is still holding the
          // dead token, so re-login on disk would otherwise never be picked up and
          // Retry would spawn straight back into the same auth failure. Closing it
          // forces a fresh process (reading the new credentials) on resume.
          const evictRoot = this._workspaceRoot;
          if (evictRoot) {
            try {
              const evictLog = (m: string) => this._cb?.log(m);
              if (currentProvider === 'claude-tui') { closeClaudeTuiClient(evictRoot, evictLog); }
              else if (currentProvider === 'opencode-sdk') { closeOpencodeSdkClient(evictRoot, evictLog); }
              else if (currentProvider === 'copilot-sdk') { closeCopilotSdkSession(evictRoot, evictLog); }
              else if (currentProvider === 'grok-tui') { closeGrokTuiSession(evictRoot, evictLog); }
            } catch (evictErr) {
              this._cb?.log(`⚠️ Failed to evict ${currentProvider} client before reauth pause: ${evictErr instanceof Error ? evictErr.message : String(evictErr)}`);
            }
          }
          // Remember the pause reason so a WS reconnect during the pause re-emits
          // reauth_required instead of clobbering it with agent_online/task_start.
          this._pauseReason = {
            event: 'reauth_required',
            payload: {
              iteration: this._iterations,
              task:      { text: task.text, id: task.id },
              message:   rawMsg,
              provider:  currentProvider,
              workDir:   this._workspaceRoot,
              gitRepo:   this._gitRepo,
              gitBranch: this._gitBranch,
            },
          };
          // Pause indefinitely (no auto-resume) — operator must re-auth + Retry.
          await this._pauseLoop();
          if (this._state !== 'running') { break; }
          continue;
        }
        // --- Rate limit: pause loop, schedule auto-resume -----------------
        if (err instanceof RateLimitError) {
          // Two flavours:
          //   1. Daily usage limit — message includes "resets 9pm (Europe/Sofia)"
          //      → resume 15 min after the parsed reset time.
          //   2. Transient server throttle — "API Error: Server is temporarily
          //      limiting requests (not your usage limit) · Rate limited"
          //      → no reset time given, retry in 5 minutes by default.
          const DEFAULT_RETRY_MS = 5 * 60_000;
          const resetAt   = err.resetAt;
          const resumeMs  = resetAt ? (resetAt.getTime() - Date.now() + 15 * 60_000) : DEFAULT_RETRY_MS;
          const resumeAt  = resetAt ?? new Date(Date.now() + DEFAULT_RETRY_MS);
          const resumeStr = resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const suffix    = resetAt ? '+15 min' : 'retry in 5m (no reset time given)';
          const rawMsg    = err.rawMessage;
          const currentProvider = this._cb?.getActiveProvider() ?? 'unknown';

          // Fresh settings — check fallback config (user may have changed it after loop start)
          const freshSettings = this._workspaceRoot ? loadSettingsForRoot(this._workspaceRoot) : this._settings;
          const fallbackEnabled  = freshSettings?.fallbackProviderEnabled ?? false;
          const fallbackId       = (freshSettings?.fallbackProvider ?? '') as ProviderId;

          // Use fallback if: enabled, different from current provider, and not already on fallback
          if (fallbackEnabled && fallbackId && fallbackId !== currentProvider && !this._mainProviderBeforeFallback) {
            this._mainProviderBeforeFallback = currentProvider as ProviderId;
            this._mainProviderResumeAt = resumeAt;
            this._resumeAt = resumeAt;
            this._cb?.log(`⏩ Rate limit on ${currentProvider} — switching to ${fallbackId} until ${resumeStr} (${suffix})`);
            this._notifyDiscord(`⏩ **Rate limit on ${currentProvider}** — switching to **${fallbackId}** until ${resumeStr} (${suffix})\n\`\`\`\n${rawMsg}\n\`\`\``);
            this._notifyWebhook('rate_limit', {
              iteration:       this._iterations,
              task:            { text: task.text },
              message:         rawMsg,
              resumeAt:        resumeAt.toISOString(),
              provider:        currentProvider,
              fallbackProvider: fallbackId,
              workDir:         this._workspaceRoot,
              gitRepo:         this._gitRepo,
              gitBranch:       this._gitBranch,
            });
            // Reset task so the fallback picks it up from scratch
            await todoWriter.resetToTodo(todoPath, task).catch(() => {});
            this._cb?.setActiveProvider?.(fallbackId);
            continue; // continue loop immediately with fallback provider
          }

          // No usable fallback — standard pause
          this._cb?.log(`⏸ Rate limit hit — ${rawMsg}. Auto-resume at ${resumeStr} (${suffix})`);
          this._notifyDiscord(`⏸ **Rate limit hit** — resuming at ${resumeStr} (${suffix})\n\`\`\`\n${rawMsg}\n\`\`\``);
          this._notifyWebhook('rate_limit', {
            iteration:   this._iterations,
            task:        { text: task.text },
            message:     rawMsg,
            resumeAt:    resumeAt.toISOString(),
            provider:    currentProvider,
            workDir:     this._workspaceRoot,
            gitRepo:     this._gitRepo,
            gitBranch:   this._gitBranch,
          });
          // Reset task so it gets picked up again after resume
          await todoWriter.resetToTodo(todoPath, task).catch(() => {});
          // Local hooks record for external monitors (see reauth note above).
          if (this._workspaceRoot) {
            appendHookEventLine(this._workspaceRoot, {
              hook_event_name: 'rate_limit', event_type: 'rate_limit',
              provider: currentProvider, cwd: this._workspaceRoot, message: rawMsg,
              title: `Rate-limited — resumes ${resumeStr}`, tool_name: '', timestamp: new Date().toISOString(),
            });
          }
          // Remember the pause reason so a WS reconnect during the pause re-emits
          // rate_limit instead of clobbering it with agent_online/task_start.
          this._pauseReason = {
            event: 'rate_limit',
            payload: {
              iteration:   this._iterations,
              task:        { text: task.text },
              message:     rawMsg,
              resumeAt:    resumeAt.toISOString(),
              provider:    currentProvider,
              workDir:     this._workspaceRoot,
              gitRepo:     this._gitRepo,
              gitBranch:   this._gitBranch,
            },
          };
          // Block here until resumed (timer or user clicks Retry Now)
          this._resumeAt = resumeAt;
          await this._pauseLoop(resumeMs);
          // After resume, if user stopped while paused, exit the while loop
          if (this._state !== 'running') { break; }
          continue; // pick up the same task at the top of the loop
        }
        // --- Thrashing: /compact is failing, Claude recommends /clear -----
        if (err instanceof ThrashingError) {
          const rawMsg = err.rawMessage.slice(0, 300);
          const provider = this._cb?.getActiveProvider() ?? '';
          this._cb?.log(`🗑 Autocompact thrashing (${provider}) — running /clear to reset session…\n${rawMsg}`);
          this._notifyDiscord(`🗑 **Autocompact thrashing** (${provider}) — running \`/clear\` to reset session…\n\`\`\`\n${rawMsg}\n\`\`\``);

          if (provider === 'claude-cli') {
            let sessionId = getSessionId(this._workspaceRoot!, 'claude-cli');
            if (!sessionId) { sessionId = findLatestClaudeSession(this._workspaceRoot!); }
            if (sessionId) {
              try {
                await runClaudeClear(sessionId, this._workspaceRoot!, msg => this._cb?.log(msg));
                clearSessionId(this._workspaceRoot!, 'claude-cli');
                this._cb?.log('🗑 /clear complete — session reset, retrying task');
                this._notifyDiscord('🗑 `/clear` complete — session reset, retrying task');
              } catch (e) {
                this._cb?.log(`⚠️ /clear failed: ${e instanceof Error ? e.message : String(e)} — retrying anyway`);
              }
            } else {
              this._cb?.log('⚠️ No Claude session ID found for /clear — retrying anyway');
            }
          } else if (provider === 'claude-tui') {
            let sessionId = getSessionId(this._workspaceRoot!, 'claude-tui');
            if (!sessionId) { sessionId = getClaudeTuiLatestSessionId(this._workspaceRoot!); }
            if (sessionId) {
              try {
                await runClaudeTuiClear(this._workspaceRoot!, sessionId, msg => this._cb?.log(msg));
                clearSessionId(this._workspaceRoot!, 'claude-tui');
                this._cb?.log('🗑 /clear (TUI) complete — session reset, retrying task');
                this._notifyDiscord('🗑 `/clear` (TUI) complete — session reset, retrying task');
              } catch (e) {
                this._cb?.log(`⚠️ /clear (TUI) failed: ${e instanceof Error ? e.message : String(e)} — retrying anyway`);
              }
            } else {
              this._cb?.log('⚠️ No Claude TUI session ID found for /clear — retrying anyway');
            }
          }
          this._compactedTaskLines.delete(task.line); // allow compact to run again next time
          await todoWriter.resetToTodo(todoPath, task).catch(() => {});
          continue;
        }
        // --- Context length (OpenCode + Claude): run /compact once then retry
        if (err instanceof ContextLengthError && !this._compactedTaskLines.has(task.line)) {
          this._compactedTaskLines.add(task.line);
          const rawMsg = err.rawMessage.slice(0, 300);
          const provider = this._cb?.getActiveProvider() ?? '';
          this._cb?.log(`🗜 Context length exceeded (${provider}) — running /compact: ${rawMsg}`);
          this._notifyDiscord(`🗜 **Context length exceeded** (${provider}) — running \`/compact\`…\n\`\`\`\n${rawMsg}\n\`\`\``);

          if (provider === 'claude-cli') {
            // Resolve a Claude session ID — prefer the saved one, else scan
            // the .claude/projects jsonl folder for the most recent.
            let sessionId = getSessionId(this._workspaceRoot!, 'claude-cli');
            if (!sessionId) { sessionId = findLatestClaudeSession(this._workspaceRoot!); }
            if (sessionId) {
              try {
                await runClaudeCompact(sessionId, this._workspaceRoot!, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Claude compact complete — retrying task');
                this._notifyDiscord('🗜 Claude compact complete — retrying task');
              } catch (compactErr) {
                const compactMsg = compactErr instanceof Error ? compactErr.message : String(compactErr);
                this._cb?.log(`⚠️ Claude compact failed: ${compactMsg} — retrying anyway`);
              }
            } else {
              this._cb?.log('⚠️ No Claude session ID found for compact — retrying task without compact');
            }
          } else if (provider === 'claude-tui') {
            let sessionId = getSessionId(this._workspaceRoot!, 'claude-tui');
            if (!sessionId) { sessionId = getClaudeTuiLatestSessionId(this._workspaceRoot!); }
            if (sessionId) {
              try {
                await runClaudeTuiCompact(this._workspaceRoot!, sessionId, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Claude TUI compact complete — retrying task');
                this._notifyDiscord('🗜 Claude TUI compact complete — retrying task');
              } catch (compactErr) {
                const compactMsg = compactErr instanceof Error ? compactErr.message : String(compactErr);
                this._cb?.log(`⚠️ Claude TUI compact failed: ${compactMsg} — retrying anyway`);
              }
            } else {
              this._cb?.log('⚠️ No Claude TUI session ID found for compact — retrying task without compact');
            }
          } else {
            // OpenCode (existing behaviour)
            let sessionId = getSessionId(this._workspaceRoot!, 'opencode-cli');
            if (!sessionId) {
              sessionId = await getLatestOpenCodeSessionId(this._workspaceRoot!, msg => this._cb?.log(msg));
            }
            if (sessionId) {
              try {
                await runOpenCodeCompact(sessionId, this._workspaceRoot!, msg => this._cb?.log(msg));
                this._cb?.log('🗜 Compact complete — retrying task');
                this._notifyDiscord('🗜 Compact complete — retrying task');
              } catch (compactErr) {
                const compactMsg = compactErr instanceof Error ? compactErr.message : String(compactErr);
                this._cb?.log(`⚠️ Compact failed: ${compactMsg} — retrying anyway`);
              }
            } else {
              this._cb?.log('⚠️ No OpenCode session ID found for compact — retrying task without compact');
            }
          }
          await todoWriter.resetToTodo(todoPath, task).catch(() => {});
          continue;
        }
        // --- Context length already compacted or plan limit: pause + retry button
        if (err instanceof ContextLengthError) {
          const rawMsg = err.rawMessage.slice(0, 300);
          const provider = this._cb?.getActiveProvider() ?? '';
          this._cb?.log(`⏸ Context length exceeded (${provider}) and already compacted — pausing. Click Retry to resume.\n${rawMsg}`);
          this._notifyDiscord(`⏸ **Context length exceeded** (${provider}) — already compacted or plan limit hit. Pausing…\n\`\`\`\n${rawMsg}\n\`\`\``);
          this._notifyWebhook('rate_limit', {
            iteration:   this._iterations,
            task:        { text: task.text },
            message:     rawMsg,
            resumeAt:    new Date(Date.now() + 60 * 60_000).toISOString(),
            provider,
            workDir:     this._workspaceRoot,
            gitRepo:     this._gitRepo,
            gitBranch:   this._gitBranch,
          });
          await todoWriter.resetToTodo(todoPath, task).catch(() => {});
          // Remember the pause reason so a WS reconnect during the pause re-emits
          // it instead of clobbering it with agent_online/task_start.
          this._pauseReason = {
            event: 'rate_limit',
            payload: {
              iteration:   this._iterations,
              task:        { text: task.text },
              message:     rawMsg,
              resumeAt:    new Date(Date.now() + 60 * 60_000).toISOString(),
              provider,
              workDir:     this._workspaceRoot,
              gitRepo:     this._gitRepo,
              gitBranch:   this._gitBranch,
            },
          };
          // No auto-resume time — user must click Retry manually
          this._resumeAt = undefined;
          await this._pauseLoop(); // pause indefinitely
          if (this._state !== 'running') { break; }
          continue;
        }
        // --- Normal task failure ------------------------------------------
        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        this._failedCount++;
        const msg = err instanceof Error ? err.message : String(err);
        this._cb?.log(`❌ Task failed: ${task.text} — ${msg}`);
        this._notifyWebhook('task_fail', {
          iteration: this._iterations,
          task:      { text: task.text, id: task.id },
          duration,
          error:     msg,
          workDir:   this._workspaceRoot,
          gitRepo:   this._gitRepo,
          gitBranch: this._gitBranch,
        });
        this._notifyDiscord(`❌ **Task failed:**\n${discordLabel(task.text)}\n\`${msg}\``);        const afterRemainingFail = countRemaining(parseTodo(todoPath));
        if (afterRemainingFail > 0) {
          const totalKnownFail = this._iterations + afterRemainingFail;
          this._notifyDiscord(`\ud83d\udcca Progress: ${this._iterations}/${totalKnownFail}`);
          this._notifyWebhook('task_progress', {
            iteration: this._iterations,
            total:     totalKnownFail,
            remaining: afterRemainingFail,
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
        }        // Continue to next task rather than stopping the loop
      }

      this._currentTask = undefined;
    }
  }

  /**
   * Suspend the loop in 'paused' state.
   * Resolves when retry() is called or (optionally) the timer fires.
   * MUST be called only from _runLoop.
   */
  private _pauseLoop(resumeAfterMs?: number): Promise<void> {
    this._setState('paused');
    return new Promise<void>(resolve => {
      this._resumeResolve = resolve;
      if (resumeAfterMs !== undefined && resumeAfterMs > 0) {
        this._retryScheduler.schedule(resumeAfterMs, () => {
          this._cb?.log('Rate limit timer expired — resuming loop automatically');
          this.retry();
        });
      }
    });
  }

  /** Interrupt the idle no-task sleep — called by pollers when they append a task. */
  private _wakeIdleSleep(): void {
    const w = this._idleSleepWake;
    this._idleSleepWake = null;
    w?.();
  }

  /** sleep() that resolves early when _wakeIdleSleep() is called. */
  private _sleepOrWake(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const id = setTimeout(resolve, ms);
      this._idleSleepWake = () => { clearTimeout(id); resolve(); };
    });
  }

  /** sleep() that resolves immediately when the task-completion abort fires. */
  private _sleepAbortable(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const id = setTimeout(resolve, ms);
      const prev = this._taskCompletionAbort;
      this._taskCompletionAbort = () => { clearTimeout(id); resolve(); prev?.(); };
    });
  }

  /** Return when the task text appears with [x] status in the TODO.md file. */
  private _waitForTaskCompletion(todoPath: string, task: Task, claudeCursor = 0): Promise<void> {
    const isClaudeCli = this._cb?.getActiveProvider() === 'claude-cli';
    const isClaudeTui = this._cb?.getActiveProvider() === 'claude-tui';
    const iscopilotSdkProvider = this._cb?.getActiveProvider() === 'copilot-sdk';
    const isOpenCodeCli = this._cb?.getActiveProvider() === 'opencode-cli';
    const isOpencodeSdk = this._cb?.getActiveProvider() === 'opencode-sdk';
    // grok-cli / grok-tui / copilot-cli all tee stdout too — without these flags
    // the rate-limit / context-length / thrash detectors never ran for them, so
    // a throttled or context-blown turn was silently walked to give_up and the
    // task was falsely marked [x].
    const isGrokCli    = this._cb?.getActiveProvider() === 'grok-cli';
    const isGrokTui    = this._cb?.getActiveProvider() === 'grok-tui';
    const isCopilotCli = this._cb?.getActiveProvider() === 'copilot-cli';

    // Live chat streaming for the two shell-command CLI providers. copilot-cli
    // and opencode-cli run as teed shell commands, so — unlike Claude (native
    // hooks), grok (streaming-json → Notification) and the SDK providers
    // (in-process event callbacks) — they emit NO incremental hook events during
    // a turn; the chat only updated at the SessionStart/SessionEnd boundaries.
    // Their only live signal is the growing teed stdout file, which checkStdout()
    // already tails. Feed that stdout (ANSI-stripped) through a narrator so each
    // chunk becomes a `Notification` hook event, giving line/chunk-granularity
    // live output. (Claude/grok/SDK providers already stream and are untouched.)
    const cliNarrator = (this._workspaceRoot && (isCopilotCli || isOpenCodeCli))
      ? new LiveNarrationStreamer(
          this._cb!.getActiveProvider() ?? 'cli',
          this._workspaceRoot,
          ev => appendHookEventLine(this._workspaceRoot!, ev),
        )
      : null;
    // Independent cursor so narration doesn't disturb the claude-cli Discord
    // forwarding cursor (lastStdoutLen) below.
    let lastNarratedLen = 0;

    return new Promise<void>((resolve, reject) => {
      if (this._state !== 'running') { resolve(); return; }

      const settings = this._settings!;
      const timeoutMs  = (settings.taskTimeoutMinutes  ?? 30) * 60 * 1_000;
      const taskStartTime = Date.now();

      // Timeout is based on TODO.md inactivity, not total process runtime.
      // Every time TODO.md changes (any [~]/[x] write by the AI) this resets.
      // Only fires if TODO.md has been untouched for the full timeout duration.
      let lastTodoChangeTime = Date.now();
      // Shared with the JSONL inactivity poller — reset here so TODO.md changes
      // prevent the "Still working" reminder from firing unnecessarily.
      let lastActivityTime   = Date.now();

      const found = () => {
        const updated = parseTodo(todoPath);
        // 1. Prefer task ID (globally unique — set by appendTask on every new task).
        // 2. Line number with text verification (fast; guards against line-shift from
        //    new tasks inserted above this one pointing to the wrong entry).
        // 3. Text-only fallback when there is no ID and the line has shifted.
        const byId           = task.id ? updated.find(t => t.id === task.id) : undefined;
        const byLine         = updated.find(t => t.line === task.line);
        const byLineVerified = (byLine && byLine.text === task.text) ? byLine : undefined;
        const byText         = updated.find(t => t.text === task.text);
        const match          = byId ?? byLineVerified ?? byText;
        // If the current task can no longer be found but there are no pending
        // tasks left at all, treat it as completed. This avoids re-prompt loops
        // where the CLI exits cleanly after finishing work but TODO matching was
        // invalidated by line shifts or post-processing.
        if (!match) { return countRemaining(updated) === 0 ? true : undefined; }
        return match.status === 'done';
      };

      // Track "task not found" state to detect line-number shifts from new tasks.
      // If task becomes unfindable, give it 3 seconds grace before treating as lost.
      let taskLostAt: number | null = null;

      // Check immediately (AI might have already edited the file)
      if (found() === true) { resolve(); return; }

      let poller: NodeJS.Timeout | undefined;
      let stdoutWatcherRef: IDisposable | undefined;
      let exitWatcherRef: IDisposable | undefined;
      let todoWatcher: IDisposable | undefined;
      const endTurnTimers: NodeJS.Timeout[] = [];
      // Set to true by cleanup() so stale onCliExit() calls that are still
      // sleeping don't send a spurious reminder after the task resolved.
      let cancelled = false;

      const cleanup = () => {
        cancelled = true;
        this._taskCompletionAbort = null;
        // Emit any trailing streamed CLI output so the turn's final lines reach
        // the chat before the watchers are torn down.
        cliNarrator?.flush();
        clearInterval(poller);
        for (const t of endTurnTimers) { clearTimeout(t); }
        endTurnTimers.length = 0;
        todoWatcher?.dispose();
        stdoutWatcherRef?.dispose();
        stdoutWatcherRef = undefined;
        exitWatcherRef?.dispose();
        exitWatcherRef = undefined;
        this._cb?.onActivityChange?.(undefined);
      };

      const check = () => {
        if (this._state !== 'running') { cleanup(); resolve(); return; }
        const state = found();  // returns true (done), false (undefined), or undefined (not found)
        
        if (state === true) {
          // Task explicitly marked [x] done
          lastTodoChangeTime = Date.now(); // reset inactivity clock
          lastActivityTime = Date.now();
          cleanup(); 
          resolve(); 
          return;
        }
        
        if (state === false) {
          // Task marked [~] in-progress or other non-done status
          lastTodoChangeTime = Date.now();
          lastActivityTime = Date.now();
          taskLostAt = null; // task found again, reset lost timer
          return;
        }
        
        // state === undefined: task not found in TODO.md
        if (taskLostAt === null) {
          // First time seeing task as lost — start the grace period
          taskLostAt = Date.now();
          this._cb?.log(`⚠️ Task became unfindable in TODO.md (line shift from new tasks?) — giving 3s grace period…`);
          return;
        }
        
        // Check if grace period expired
        if (Date.now() - taskLostAt > 3_000) {
          this._cb?.log(`⚠️ Task still unfindable after 3s grace period — treating as lost and resolving`);
          cleanup();
          resolve();
          return;
        }
      };

      todoWatcher = this._cb!.fileWatcher.watch(todoPath, check);
      this._taskWatcher = todoWatcher;

      // Per-provider stdout capture file (only used for CLI providers)
      const activeProvider = this._cb?.getActiveProvider() ?? 'unknown';
      // Re-computed dynamically — sendToAi() (reminder path) rotates to a fresh
      // per-message file and updates the .latest pointer.  Using a let + refresh
      // in the interval ensures checkStdout() always reads the current file.
      let resolvedStdoutFile = this._workspaceRoot
        ? stdoutFilePath(this._workspaceRoot, activeProvider)
        : null;

      // Helper: read stdout capture file handling both UTF-8 and UTF-16 LE (PowerShell default)
      const readStdoutFile = (): string => {
        if (!resolvedStdoutFile) { return ''; }
        try {
          const buf = fs.readFileSync(resolvedStdoutFile);
          // Detect UTF-16 LE BOM (0xFF 0xFE)
          if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
            return buf.toString('utf16le');
          }
          return buf.toString('utf8');
        } catch { return ''; }
      };

      // Track how many characters of the stdout file we've already forwarded
      let lastStdoutLen = 0;

      // Check stdout file: forward any new content to Discord/webhook, detect rate limit / context errors
      // Providers that write a stdout capture file we can scan for failure
      // banners (rate-limit / context-length / thrash). Every CLI/TUI provider
      // tees stdout; the two Claude ones and OpenCode also stream/parse extra.
      const teesStdout = isClaudeCli || isClaudeTui || iscopilotSdkProvider || isOpenCodeCli
        || isGrokCli || isGrokTui || isCopilotCli;
      const checkStdout = () => {
        if (!teesStdout) { return; }
        const content = readStdoutFile();

        // Stream new stdout to the chat live for the shell-command CLI providers
        // (copilot-cli / opencode-cli). Uses its own cursor so it is independent
        // of the claude-cli Discord-forwarding cursor below.
        if (cliNarrator && content.length > lastNarratedLen) {
          const chunk = content.slice(lastNarratedLen);
          lastNarratedLen = content.length;
          cliNarrator.push(stripAnsi(chunk));
        }

        // Forward new output lines to Discord / webhook.
        // claude-cli: stream partial chunks so the operator can see live progress.
        // claude-tui: do NOT stream — the TUI writes noisy partial chunks; we
        //   send one clean summary from the JSONL session file at task completion
        //   (same approach as opencode).
        if (isClaudeCli && content.length > lastStdoutLen) {
          const newText = content.slice(lastStdoutLen).trim();
          lastStdoutLen = content.length;
          if (newText) {
            this._notifyDiscord(`🖥 **Claude output:**\n\`\`\`\n${newText}\n\`\`\``);
            this._notifyWebhook('claude_output', {
              iteration: this._iterations,
              task:      { text: task.text, id: task.id },
              output:    newText,
              workDir:   this._workspaceRoot,
              gitRepo:   this._gitRepo,
              gitBranch: this._gitBranch,
            });
          }
        } else {
          lastStdoutLen = content.length; // keep cursor up to date
        }

        // Auth-failure detection is intentionally NOT run here mid-stream. For
        // claude-tui (and other teeing providers) this growing capture is the
        // model's own assistant transcript, so an ordinary task that merely
        // mentions auth/login ("handle the authentication_error case") would
        // trip AuthDetector and brick the running turn into a false reauth
        // pause. Auth is detected only on the process-EXIT buffer (see onCliExit
        // below), which is the provider's real failure surface — a logged-out /
        // out-of-credit CLI exits fast and is caught there.

        // Rate-limit detection is intentionally NOT run here mid-stream, for the
        // same reason as auth above: for every stdout-teeing provider this
        // growing capture IS the model's own assistant transcript, and the
        // RateLimitDetector phrases (/api error … rate limit/, /· rate limited/)
        // are exactly what an agent emits while building/debugging 429 handling
        // or pasting an API-error body into its reasoning — which would falsely
        // pause a healthy turn. The process-EXIT buffer is the provider's real
        // throttle surface and is still scanned unconditionally (onCliExit
        // below), so a genuine rate-limit exit is caught there.

        // Context length error detection (OpenCode)
        if (isOpenCodeCli) {
          const lc = content.toLowerCase();
          if (lc.includes('maximum context length') || lc.includes('prompt is too long')) {
            cleanup();
            reject(new ContextLengthError(content.trim()));
            return;
          }
        }

        // Context-length / thrash detection for the remaining CLI+TUI providers.
        // Patterns observed:
        //   "prompt is too long: 1018289 tokens > 1000000 maximum"
        //   "Prompt is too long" (last_assistant_message in StopFailure hook)
        //   "context_length_exceeded" / "maximum context length"
        //   "Autocompact is thrashing" (context refills immediately after compact)
        if (isClaudeCli || isClaudeTui || isGrokCli || isGrokTui || isCopilotCli) {
          const lc = content.toLowerCase();
          if (lc.includes('autocompact is thrashing')) {
            cleanup();
            reject(new ThrashingError(content.trim()));
            return;
          }
          if (lc.includes('prompt is too long')
              || lc.includes('context_length_exceeded')
              || lc.includes('maximum context length')
              || /tokens?\s*>\s*\d+\s*maximum/.test(lc)) {
            cleanup();
            reject(new ContextLengthError(content.trim()));
            return;
          }
        }
      };

      // Register abort hook so stop() can resolve this immediately
      this._taskCompletionAbort = () => { cleanup(); resolve(); };

      // Watch the per-provider stdout capture file for instant rate-limit detection.
      // Use the actual per-message file, not the legacy provider-level path, so the
      // watcher fires on the file the current process is writing to.
      const attachStdoutWatcher = (filePath: string | null) => {
        stdoutWatcherRef?.dispose();
        stdoutWatcherRef = filePath
          ? this._cb!.fileWatcher.watch(filePath, checkStdout)
          : undefined;
      };
      attachStdoutWatcher(resolvedStdoutFile);

      // Watch the exit file — written by withExitFile() in dispatcher.ts when the CLI
      // process finishes. CliExitHandler owns the decision tree of what to do.
      const isTaskDone = () => found() === true;
      const exitHandler = this._workspaceRoot
        ? new CliExitHandler(this._workspaceRoot, todoPath, task, taskStartTime, isTaskDone)
        : null;
      const onCliExit = async () => {
        if (this._state !== 'running') { return; }
        // Give TODO.md enough time to be fully flushed and for any final Claude
        // writes (session ID capture etc.) to settle before we declare it undone.
        await sleep(3_000);
        // A parallel path (todoWatcher / poller check()) may have already
        // resolved the promise while we were sleeping.  Don't send a spurious
        // reminder to the next task's session.
        if (cancelled) { return; }

        // Fast-path: if the stdout capture file already contains a rate-limit
        // or context-length phrase at exit time, raise immediately. Applies to
        // every stdout-teeing provider so a throttled grok/copilot exit pauses
        // instead of being force-marked done.
        const exitStdout = readStdoutFile();
        // Read the process exit code. Auth-failure detection must be gated on a
        // NON-ZERO exit: for claude-tui the stdout capture IS the model's own
        // assistant transcript, so a *successful* task (exit 0) whose output
        // legitimately contains {"type":"authentication_error"} — e.g. code
        // working on Anthropic API handling, or a pasted 401 body — would trip
        // AuthDetector and pause the loop indefinitely over benign output. Real
        // auth/credit failures exit non-zero (the provider appends `[Error: …]`),
        // so gating on the exit code loses nothing. Rate-limit detection stays
        // ungated — its phrases are error-scoped and a throttle can surface on a
        // zero exit for some providers.
        const exitCodeRaw = this._workspaceRoot
          ? ((): string => { try { return fs.readFileSync(exitFilePath(this._workspaceRoot!, activeProvider), 'utf8').trim(); } catch { return ''; } })()
          : '';
        const exitedNonZero = exitCodeRaw !== '' && exitCodeRaw !== '0';
        if (teesStdout) {
          if (exitedNonZero) {
            const authFromStdout = AuthDetector.detect(exitStdout);
            if (authFromStdout) {
              cleanup();
              reject(authFromStdout);
              return;
            }
          }
          const rlFromStdout = RateLimitDetector.detect(exitStdout);
          if (rlFromStdout) {
            cleanup();
            reject(rlFromStdout);
            return;
          }
        }
        if (isOpenCodeCli) {
          const lc = exitStdout.toLowerCase();
          if (lc.includes('maximum context length') || lc.includes('prompt is too long')) {
            cleanup();
            reject(new ContextLengthError(exitStdout.trim()));
            return;
          }
        }

        // opencode's SDK path surfaces a session.error as an `[ERROR] …` line in
        // its stdout capture yet still writes exit-code 0 — so the process exit
        // code alone can't see it. Pass that sentinel through so a session.error
        // ("No model available" on a copilot-backed free plan, etc.) is treated
        // as the provider hard-failure it is, not a completed task.
        const stdoutError = ((isOpenCodeCli || isOpencodeSdk) && /\[ERROR\]/.test(exitStdout))
          ? 'session-error'
          : null;
        const decision = exitHandler?.decide({ exitedNonZero, stdoutError })
          ?? { kind: 'remind' as const };

        if (decision.kind === 'done') { return; }

        if (decision.kind === 'hard_fail') {
          // The PROVIDER hard-failed (reauth / session error / watchdog-no-output
          // / crash / model unavailable) and produced no real work. Do NOT mark
          // the task [x] done — that would report an outage as SUCCESS. Instead
          // flag it [~] blocked, report an honest failure to the office (task_fail
          // → TASK_STATE_FAILED, "needs attention") and record a StopFailure hook
          // so external monitors see it too. The task stays claimable/retryable.
          const reason = decision.reason;
          this._failedCount++;
          const taskKey = task.id ?? task.text;
          this._blockedTasks.add(taskKey);
          // Drop the attempt counter so a later retry gets a clean run rather
          // than being force-marked done on its first re-dispatch.
          this._taskAttempts.delete(taskKey);
          this._cb?.log(`⛔ Provider hard-failure (${reason}) — NOT marking done; flagging task as blocked/needs-attention: ${discordLabel(task.text)}`);
          await todoWriter.markInProgress(todoPath, task).catch(() => {});
          const duration = Math.round((Date.now() - taskStartTime) / 1000);
          const errText = `provider hard-failure: ${reason} (task not completed — needs attention)`;
          this._notifyWebhook('task_fail', {
            iteration: this._iterations,
            task:      { text: task.text, id: task.id },
            duration,
            error:     errText,
            reason,
            workDir:   this._workspaceRoot,
            gitRepo:   this._gitRepo,
            gitBranch: this._gitBranch,
          });
          this._notifyDiscord(`⛔ **Provider failure — task blocked (not done):**\n${discordLabel(task.text)}\n\`${reason}\``);
          if (this._workspaceRoot) {
            appendHookEventLine(this._workspaceRoot, {
              hook_event_name: 'StopFailure', event_type: 'stop_failure',
              provider: activeProvider, cwd: this._workspaceRoot, error: reason,
              title: 'Provider failure', message: errText, tool_name: '',
              timestamp: new Date().toISOString(),
            });
          }
          cleanup();
          resolve();
          return;
        }

        if (decision.kind === 'deferred') {
          this._cb?.log(`↩️ CLI exited with task [~] deferred — moving to next pending task: ${discordLabel(task.text)}`);
          cleanup();
          resolve();
          return;
        }

        if (decision.kind === 'rate_limit') {
          cleanup();
          reject(decision.error);
          return;
        }

        if (decision.kind === 'give_up') {
          this._cb?.log(`↩️ CLI exited again without marking task done — auto-marking [x] and moving on: ${discordLabel(task.text)}`);
          // Auto-mark the task done so the loop doesn't re-pick the same
          // [ ] task on the next iteration, causing an infinite loop.
          await todoWriter.markDone(todoPath, task).catch(() => {});
          cleanup();
          resolve();
          return;
        }

        // decision.kind === 'remind'
        const elapsedMin = Math.round((Date.now() - taskStartTime) / 60_000);
        const msg = `⏳ CLI finished but task not yet marked done (${elapsedMin}m): ${discordLabel(task.text)}`;
        this._cb?.log(msg);
        this._notifyDiscord(msg);
        this._notifyWebhook('task_checkin', {
          iteration:      this._iterations,
          task:           { text: task.text },
          elapsedMinutes: elapsedMin,
          workDir:        this._workspaceRoot,
          gitRepo:        this._gitRepo,
          gitBranch:      this._gitBranch,
        });
        const date = new Date().toISOString().slice(0, 10);
        // Read the actual current marker from TODO.md so the reminder is accurate.
        // If Claude never started the task it will be [ ]; if it marked it in-progress
        // but then exited it will be [~]. Using the wrong marker causes the AI to fail
        // to locate the line and exit again without making any change.
        const currentTasks = parseTodo(todoPath);
        const currentLine  = currentTasks.find(t => t.line === task.line || t.text === task.text);
        const currentMarker = currentLine?.status === 'in-progress' ? '~' : ' ';
        const reminder = [
          `⚠️ ACTION REQUIRED: Your process has finished but your current task is NOT marked done in TODO.md.`,
          `Do NOT stop. Do NOT wait. Update TODO.md right now, then continue to the next task.`,
          `Read TODO.md now: cat ${todoPath}`,
          ``,
          `Find line ${task.line} (task: ${task.text}):`,
          `  - [${currentMarker}] ${task.text}`,
          ``,
          `You MUST change it to one of:`,
          `  [x] – done:        - [x] ${date}  ${task.text}`,
          `  [~] – in progress: - [~] ${task.text}`,
          ``,
          `After saving the file, immediately continue to the next [ ] task. Do not exit or wait for instructions.`,
        ].join('\n');
        this._cb?.log(`⚠️ CLI exited: reminding AI to mark TODO.md (${elapsedMin}m elapsed)`);
        try {
          const reminderFile = writeMessageFile(this._workspaceRoot!, reminder);
          await this._cb!.sendToAi(reminder, task.text, false, reminderFile);
        } catch { /* ignore */ }
      };

      // Track which exit file we are currently watching so the poller can
      // re-attach when sendToAi() rotates to a new per-message exit file.
      let watchedExitFile: string | null = null;
      // Path of the exit file for which onCliExit() has already been invoked.
      // Prevents the watcher AND the poller fallback from both firing onCliExit()
      // for the same exit event (the guard is set by whichever fires first).
      let handledExitFile: string | null = null;

      const attachExitWatcher = (filePath: string) => {
        if (filePath === watchedExitFile) { return; } // already watching this file
        exitWatcherRef?.dispose();
        watchedExitFile = filePath;
        exitWatcherRef = this._cb!.fileWatcher.watch(filePath, () => {
          if (handledExitFile === filePath) { return; } // poller already handled
          try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content === '') { return; } // file cleared at task start — ignore
          } catch { return; }
          handledExitFile = filePath;
          void onCliExit();
        });
      };

      // opencode-sdk: the persistent in-process SDK doesn't use the CLI exit-file
      // reminder flow — doing so causes a re-prompt loop (the SDK writes '0' to the
      // exit file when session.idle fires, the poller sees it, calls onCliExit(),
      // which re-sends the prompt, which loops).  Instead, the poller resolves this
      // promise directly when isOpencodeSdkBusy() becomes false (see below).
      if (!isOpencodeSdk && this._workspaceRoot) {
        attachExitWatcher(exitFilePath(this._workspaceRoot, activeProvider));
      }

      // Inactivity-based check-in: track Claude JSONL byte size every 3 s.
      // After 15 minutes of silence (no new bytes), send the TODO.md reminder.
      // Resets when Claude writes again so we don't spam.
      const INACTIVITY_MS = 15 * 60 * 1_000;
      let endTurnSeen = false;
      let lastJSONLSize = claudeCursor > 0 && this._workspaceRoot
        ? getClaudeSessionCursor(this._workspaceRoot) : 0;
      // lastActivityTime is declared above (shared with check())
      let reminderPending = true; // allow one reminder per quiet period
      let lastActivity: string | undefined;

      poller = setInterval(async () => {
        check();
        checkStdout(); // also poll stdout every tick — file watcher can miss events on Linux

        if (!this._workspaceRoot) { return; }

        // If sendToAi() was called (e.g. reminder path) it rotates to a new
        // per-message stdout/exit file.  Re-attach both watchers so the next
        // process's output and exit are both detected even though the paths changed.
        const latestStdout = this._workspaceRoot ? stdoutFilePath(this._workspaceRoot, activeProvider) : null;
        if (latestStdout && latestStdout !== resolvedStdoutFile) {
          resolvedStdoutFile = latestStdout;
          lastStdoutLen = 0; // reset cursor — new file starts from byte 0
          attachStdoutWatcher(resolvedStdoutFile);
        }

        const latestExit = exitFilePath(this._workspaceRoot, activeProvider);
        if (!isOpencodeSdk && latestExit !== watchedExitFile) { attachExitWatcher(latestExit); }

        // opencode-sdk: resolve _waitForTaskCompletion as soon as the SDK
        // session goes idle (isOpencodeSdkBusy false).  This avoids the
        // CLI-style onCliExit() reminder re-prompt loop that the exit-file
        // mechanism would otherwise trigger.
        if (isOpencodeSdk && this._workspaceRoot && !isOpencodeSdkBusy(this._workspaceRoot)) {
          check(); // one last todo-file check before resolving
          if (!cancelled) { cleanup(); resolve(); }
          return;
        }

        // Poller-based exit fallback: the VS Code file-system watcher can miss
        // events (gitignored dirs, inotify limits, fast exits before re-attach).
        // Read the exit file directly every tick and trigger onCliExit() if it
        // became non-empty without the watcher firing.
        if (!isOpencodeSdk && latestExit && latestExit !== handledExitFile) {
          try {
            if (fs.readFileSync(latestExit, 'utf8').trim() !== '') {
              handledExitFile = latestExit;
              void onCliExit();
            } else if (isOpenCodeCli && this._workspaceRoot) {
              // Empty exit file: the opencode process may have been killed before
              // writing the exit code (VS Code restart, OOM, terminal force-close).
              // If opencode is no longer active (hooks JSONL stale > 90s) and a
              // minimum grace period has elapsed, treat it as an unclean exit so
              // CliExitHandler can decide whether to retry, remind, or give up.
              const minWaitMs = 2 * 60 * 1_000; // 2 min grace period for startup
              if (Date.now() - taskStartTime > minWaitMs
                  && !isOpenCodeCliActive(this._workspaceRoot)) {
                handledExitFile = latestExit;
                void onCliExit();
              }
            }
          } catch { /* file not yet written — ignore */ }
        }

        // Parse rich JSONL state: end_turn, active tool, bash progress
        if (claudeCursor > 0) {
          const sessionState = parseClaudeStateSince(this._workspaceRoot, claudeCursor);

          // end_turn detection — fast-path on Linux where inotify can lag
          if (!endTurnSeen && sessionState.hasEndTurn) {
            endTurnSeen = true;
            this._cb?.log('end_turn detected in Claude JSONL — checking TODO.md');
            endTurnTimers.push(setTimeout(check, 800));
            endTurnTimers.push(setTimeout(check, 2_500));
          }

          // Surface current tool activity to sidebar
          const activity = sessionState.hasEndTurn
            ? undefined
            : (sessionState.activeToolStatus ?? (sessionState.hasProgress ? 'Running command\u2026' : undefined));
          if (activity !== lastActivity) {
            lastActivity = activity;
            this._cb?.onActivityChange?.(activity);
          }

          // Rate limit detection — reject immediately so _runLoop can pause
          if (sessionState.rateLimitMessage) {
            cleanup();
            reject(RateLimitDetector.toError(sessionState.rateLimitMessage));
            return;
          }
        }

        // (stdout capture file is already checked once at the top of this tick via
        // checkStdout() at line ~2215; a second scan here was redundant and doubled
        // the per-tick cost of re-reading the growing stdout file.)

        // Track JSONL activity
        const currentSize = getClaudeSessionCursor(this._workspaceRoot);
        if (currentSize !== lastJSONLSize) {
          lastJSONLSize = currentSize;
          lastActivityTime = Date.now();
          reminderPending = true; // new activity — allow a fresh reminder after next silence
          return;
        }

        // TODO.md inactivity timeout — fires when TODO.md has not been touched
        // for the full timeout duration (resets on every TODO.md write).
        // Checked on every tick independently of the JSONL reminder flow, so it
        // fires even after a reminder has already been sent and reminderPending=false.
        {
          const idleMs = Date.now() - lastTodoChangeTime;
          if (idleMs >= timeoutMs) {
            cleanup();
            const minutes = settings.taskTimeoutMinutes ?? 30;
            if (settings.retryOnTimeout) {
              await todoWriter.resetToTodo(todoPath, task).catch(() => {});
              const msg = `⏱ TODO.md idle for ${minutes}m — retrying: ${discordLabel(task.text)}`;
              this._cb?.log(msg);
              this._notifyDiscord(msg);
              this._notifyWebhook('task_checkin', {
                iteration:      this._iterations,
                task:           { text: task.text },
                elapsedMinutes: minutes,
                timedOut:       true,
                retrying:       true,
                workDir:        this._workspaceRoot,
                gitRepo:        this._gitRepo,
                gitBranch:      this._gitBranch,
              });
              resolve(); // loop will pick it up again as a fresh [ ] task
            } else {
              reject(new Error(`Task timed out after ${minutes} minutes of TODO.md inactivity`));
            }
            return;
          }
        }

        // No new bytes — check if we've been quiet long enough
        if (!reminderPending) { return; }
        if (Date.now() - lastActivityTime < INACTIVITY_MS) { return; }

        // 15+ minutes of JSONL silence — send one reminder
        reminderPending = false;
        if (this._state !== 'running') { return; }

        const elapsedMin = Math.round((Date.now() - taskStartTime) / 60_000);
        const msg = `⏳ Still working... (${elapsedMin}m elapsed): ${discordLabel(task.text)}`;
        this._cb?.log(msg);
        this._notifyDiscord(msg);
        this._notifyWebhook('task_checkin', {
          iteration:      this._iterations,
          task:           { text: task.text },
          elapsedMinutes: elapsedMin,
          workDir:        this._workspaceRoot,
          gitRepo:        this._gitRepo,
          gitBranch:      this._gitBranch,
        });
        const date = new Date().toISOString().slice(0, 10);
        const currentTasks2 = parseTodo(todoPath);
        const currentLine2  = currentTasks2.find(t => t.line === task.line || t.text === task.text);
        const currentMarker2 = currentLine2?.status === 'in-progress' ? '~' : ' ';
        const reminder = [
          `REMINDER: you have an unfinished task. Read TODO.md now: cat ${todoPath}`,
          ``,
          `Find line ${task.line} (task: ${task.text}):`,
          `  - [${currentMarker2}] ${task.text}`,
          ``,
          `When done, change it to:`,
          `  - [x] ${date}  ${task.text}`,
          ``,
          `If still in progress, mark it:`,
          `  - [~] ${task.text}`,
          ``,
          `Save the file. Do NOT exit without updating that line.`,
        ].join('\n');
        this._cb?.log(`⚠️ Check-in: reminding AI to mark TODO.md (${elapsedMin}m, JSONL quiet for 3m)`);
        try {
          const reminderFile = writeMessageFile(this._workspaceRoot!, reminder);
          await this._cb!.sendToAi(reminder, task.text, false, reminderFile);
        } catch { /* ignore */ }
      }, 3_000);
    });
  }

  private _disposeWatcher(): void {
    this._taskWatcher?.dispose();
    this._taskWatcher = undefined;
  }

  private _setState(state: LoopState, taskText?: string): void {
    this._state = state;
    this._cb?.onStatusChange(state, taskText);
  }

  private _notifyWebhook(event: WebhookEvent, payload?: Record<string, unknown>): void {
    this._webhook?.send(event, payload);
  }

  private _notifyDiscord(message: string): void {
    const s = this._settings;
    if (!s) { return; }
    if (s.discordToken && s.discordChannelId) {
      sendDiscordBotMessage(s.discordToken, s.discordChannelId, message);
    }
  }
}

/** Singleton runner — one loop per workspace session. */
export const taskLoopRunner = new TaskLoopRunner();
