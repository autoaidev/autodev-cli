import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderId, PROVIDERS } from './providers';
import { IProcessLauncher } from './core/adapters';
import { getSessionId, captureAndSaveSessionId, getSessionClearedAt, AGENT_PROFILE_FILE, newMessageOutput, autodevDir } from './sessionState';
import { loadSettingsForRoot } from './core/settingsLoader';
import { buildClaudeCliCommand, findLatestClaudeSession, probeClaudeSession } from './providers/claudeCliProvider';
import { buildCopilotCliCommand, probeCopilotSession } from './providers/copilotCliProvider';
import { buildOpenCodeCliCommand, getLatestOpenCodeSessionId } from './providers/opencodeCliProvider';
import { sendClaudeTuiPrompt } from './providers/claudeTuiProvider';
import { sendCopilotSdkPrompt, getLatestCopilotSdkSessionId, setCopilotSettingsToken } from './providers/copilotSdkProvider';
import { sendOpencodeSdkPrompt } from './providers/opencodeSdkProvider';
import { sendGrokTuiPrompt } from './providers/grokTuiProvider';
import { getManualHookCmd } from './hooksManager';
import { isOpenCodeHooksInstalled, installOpenCodeHooks } from './openCodeHooksManager';

// Re-export session helpers so taskLoop.ts imports don't need to change.
export {
  findLatestClaudeSession,
  getClaudeSessionCursor,
  parseClaudeStateSince,
  hasClaudeEndTurnSince,
  readClaudeOutputSince,
  ClaudeSessionState,
} from './providers/claudeCliProvider';



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function teeCommand(cmd: string, outFile: string): string {
  if (os.platform() === 'win32') {
    // $OutputEncoding controls pipe encoding; Console.OutputEncoding controls the subprocess.
    // Use UTF8Encoding($false) = UTF-8 without BOM on both.
    // Tee-Object writes the file in the system default encoding (UTF-16 LE on PS5,
    // UTF-8 on PS7) — the Node.js reader detects the BOM and decodes accordingly.
    const utf8NoBom = 'New-Object System.Text.UTF8Encoding($false)';
    return `$OutputEncoding=${utf8NoBom}; [Console]::OutputEncoding=${utf8NoBom}; ${cmd} 2>&1 | Tee-Object -FilePath ${JSON.stringify(outFile)}`;
  }
  return `{ LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ${cmd}; } 2>&1 | tee ${JSON.stringify(outFile)}`;
}

export function withExitFile(cmd: string, exitFile: string): string {
  const q = JSON.stringify(exitFile);
  if (os.platform() === 'win32') {
    return `${cmd}; [System.IO.File]::WriteAllText(${q}, $LASTEXITCODE.ToString())`;
  }
  return `{ ${cmd}; echo $? > ${q}; }`;
}

function ensureProjectGitignore(root: string, entry: string): void {
  const gitignorePath = path.join(root, '.gitignore');
  try {
    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (content.split('\n').map(l => l.trim()).includes(entry)) { return; }
    if (content.length > 0 && !content.endsWith('\n')) { content += '\n'; }
    fs.writeFileSync(gitignorePath, content + `${entry}\n`, 'utf8');
  } catch { /* ignore */ }
}

/**
 * Wrap a shell command with synthetic SessionStart / SessionEnd hook events
 * written to <workspaceRoot>/.autodev/hooks-events.jsonl. Used for providers
 * that don't have native hooks (copilot-cli, opencode-cli). Post hook always
 * runs even if the main command fails.
 */
export function wrapWithSyntheticHooks(cmd: string, provider: string, workspaceRoot: string, sessionName: string): string {
  const pre  = getManualHookCmd(provider, 'SessionStart', workspaceRoot, sessionName);
  const post = getManualHookCmd(provider, 'SessionEnd',   workspaceRoot, sessionName);
  if (os.platform() === 'win32') {
    return `${pre}; ${cmd}; ${post}`;
  }
  return `${pre}; { ${cmd}; }; ${post}`;
}

/** Combine profile + message into a temp file under .autodev/messages/ and return its path. */
export function writeCombinedFile(root: string, agentProfileFile: string, messageFile: string, includeProfile: boolean): string {
  const msgsDir = path.join(root, '.autodev', 'messages');
  if (!fs.existsSync(msgsDir)) { fs.mkdirSync(msgsDir, { recursive: true }); }
  const msgContent = fs.readFileSync(messageFile, 'utf8');
  let combined = msgContent;
  if (includeProfile) {
    const profileContent = fs.readFileSync(agentProfileFile, 'utf8');
    // Task message FIRST so the agent sees the current task immediately,
    // not buried after hundreds of lines of profile instructions.
    combined = `${msgContent}\n\n---\n\n${profileContent}`;
  }
  const combinedFile = path.join(msgsDir, `temp_${Date.now()}.md`);
  fs.writeFileSync(combinedFile, combined, 'utf8');
  return combinedFile;
}

// ---------------------------------------------------------------------------
// opencode-cli process-start cooldown
// ---------------------------------------------------------------------------

/** Epoch-ms timestamp of the last opencode-cli process launch. */
let _lastOpenCodeCliStart = 0;

/** Minimum milliseconds between consecutive opencode-cli process starts. */
const OPENCODE_CLI_COOLDOWN_MS = 30_000;

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Build the CLI command and dispatch it via the injected `launcher`.
 * `workspaceRoot` and `launcher` are provided by the caller (VS Code extension
 * passes VsProcessLauncher + workspace root; the SDK passes NodeProcessLauncher
 * + cwd).
 */
export async function sendPromptToAi(
  providerId: ProviderId,
  _prompt: string,
  log: (msg: string) => void,
  launcher: IProcessLauncher,
  workspaceRoot: string,
  includeProfile = true,
  messageFilePath?: string,
  /** Called once when a claude-tui task starts — use to reveal the output channel. */
  showOutput?: () => void,
): Promise<void> {
  const providerCfg = PROVIDERS[providerId];

  if (providerCfg.isCli) {
    const root = workspaceRoot;
    if (!root) { throw new Error('No workspace root provided'); }

    const agentProfileFile = path.join(root, AGENT_PROFILE_FILE);
    const messageFile = messageFilePath ?? path.join(root, AGENT_PROFILE_FILE.replace('AGENT_PROFILE.md', 'MESSAGE.md'));
    autodevDir(root);
    ensureProjectGitignore(root, '.autodev/');
    // Sensitive config files that may contain API keys or private server definitions
    for (const entry of [
      '.mcp.json', 'opencode.json', '.opencode.json', 'AGENTS.md', 'CLAUDE.md',
      '.claude/settings.json', '.claude/settings.local.json',
      '.vscode/mcp.json', '.vscode/settings.json',
      '.openai.json', '.copilot-instructions.md',
    ]) {
      ensureProjectGitignore(root, entry);
    }
    // AI-managed task/state files that should not pollute the repo
    for (const entry of [
      'TODO.md', 'DONE.md', 'TASKS.md', 'NOTES.md', 'SCRATCHPAD.md', 'JOURNAL.md', 'CONTRACTS.md',
      '.autodev-journal/', 'media/profile/', 'media/skills/', 'media/templates/',
      'media/AUTODEV*.md', 'media/SUBAGENT_QUICK_REF.md',
    ]) {
      ensureProjectGitignore(root, entry);
    }

    const settings = loadSettingsForRoot(root);

    // Ensure the OpenCode hooks plugin is installed for opencode providers when
    // hooks are enabled. Without it, opencode emits only the synthetic
    // SessionStart/SessionEnd events the dispatcher wraps around the command —
    // no live tool.execute stream — so the loop's activity/staleness check
    // (isOpenCodeCliActive, 90s window) reports the agent IDLE while it is still
    // working. The extension installs this on activate(); the CLI never did.
    // Installing it here (idempotent) covers BOTH entry points.
    if ((providerId === 'opencode-cli' || providerId === 'opencode-sdk') && settings.hooksEnabled) {
      try {
        if (!isOpenCodeHooksInstalled(root)) {
          installOpenCodeHooks(root);
          log('Installed OpenCode hooks plugin (.opencode/plugins) for live activity events');
        }
      } catch (err) {
        log(`OpenCode hooks plugin install skipped: ${(err as Error).message}`);
      }
    }

    const storedSessionId = settings.resumeSession ? getSessionId(root, providerId) : undefined;

    let resolvedSessionId = storedSessionId;
    if (!resolvedSessionId && settings.resumeSession) {
      if (providerId === 'claude-cli') {
        resolvedSessionId = await probeClaudeSession(root, log);
      } else if (providerId === 'copilot-cli') {
        resolvedSessionId = await probeCopilotSession(root, log);
      } else if (providerId === 'opencode-cli') {
        // Use session list (filters by directory) with notBefore to skip
        // sessions created before the last "New Session" clear.
        const clearedAt = getSessionClearedAt(root, 'opencode-cli');
        resolvedSessionId = await getLatestOpenCodeSessionId(root, log, clearedAt);
      }
      if (resolvedSessionId) {
        captureAndSaveSessionId(root, providerId, resolvedSessionId);
      }
    }

    // Allocate a fresh per-message stdout + exit file pair so back-to-back
    // tasks don't overwrite each other's output. The pointer file also moves
    // so subsequent reads from taskLoop transparently target this message.
    const { messageId, stdoutFile, exitFile } = newMessageOutput(root, providerId);
    try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(exitFile,   '', 'utf8'); } catch { /* ignore */ }
    log(`Message id: ${messageId} (output: ${path.basename(stdoutFile)})`);

    // --- claude-tui: in-process spawn, no terminal ---
    if (providerId === 'claude-tui') {
      const promptFilePath = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      sendClaudeTuiPrompt(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, settings.claudeModel || undefined, showOutput);
      log(`Claude TUI: prompt dispatched (session=${resolvedSessionId ?? 'new'})`);
      return;
    }

    // --- copilot-sdk: persistent SDK session ---
    if (providerId === 'copilot-sdk') {
      // Sync the settings-stored token so _loadAuth() picks it up even on
      // headless Linux where env vars and keytar are unavailable.
      setCopilotSettingsToken(settings.copilotGithubToken || undefined);
      const promptFilePath = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      const existingSid = getLatestCopilotSdkSessionId(root);
      sendCopilotSdkPrompt(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, showOutput);
      log(`Copilot SDK: prompt dispatched (session=${existingSid ?? 'new'})`);
      return;
    }

    // --- opencode-sdk: in-process SDK, no terminal ---
    if (providerId === 'opencode-sdk') {
      const promptFilePath = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      sendOpencodeSdkPrompt(root, promptFilePath, resolvedSessionId, stdoutFile, exitFile, log, settings.opencodeModel || undefined, showOutput);
      log(`OpenCode SDK: prompt dispatched (session=${resolvedSessionId ?? 'new'})`);
      return;
    }

    // --- grok-tui: in-process spawn, no terminal ---
    if (providerId === 'grok-tui') {
      const promptFilePath = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      sendGrokTuiPrompt(root, promptFilePath, stdoutFile, exitFile, log, settings.grokModel || undefined, showOutput);
      log('Grok TUI: prompt dispatched');
      return;
    }

    let cmd: string;
    if (providerId === 'claude-cli') {
      cmd = buildClaudeCliCommand(agentProfileFile, messageFile, resolvedSessionId, includeProfile, settings.claudeModel || undefined);
      cmd = teeCommand(cmd, stdoutFile);
    } else if (providerId === 'copilot-cli') {
      const combinedFile = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      cmd = buildCopilotCliCommand(combinedFile, resolvedSessionId, settings.copilotModel || undefined);
      cmd = teeCommand(cmd, stdoutFile);
      if (settings.hooksEnabled) {
        cmd = wrapWithSyntheticHooks(cmd, 'copilot-cli', root, path.basename(root));
      }
    } else {
      const combinedFile = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
      cmd = buildOpenCodeCliCommand(combinedFile, resolvedSessionId, settings.opencodeModel || undefined);
      cmd = teeCommand(cmd, stdoutFile);
      if (settings.hooksEnabled) {
        cmd = wrapWithSyntheticHooks(cmd, 'opencode-cli', root, path.basename(root));
      }
    }

    cmd = withExitFile(cmd, exitFile);

    // Enforce a minimum cooldown between consecutive opencode-cli process starts
    // to avoid the race condition where the previous opencode server is still
    // disposing when the new process connects, causing an immediate STOP.
    if (providerId === 'opencode-cli') {
      const elapsed = Date.now() - _lastOpenCodeCliStart;
      if (elapsed < OPENCODE_CLI_COOLDOWN_MS && _lastOpenCodeCliStart > 0) {
        const wait = OPENCODE_CLI_COOLDOWN_MS - elapsed;
        log(`⏳ opencode-cli cooldown: waiting ${Math.round(wait / 1000)}s before next start…`);
        await _sleep(wait);
      }
      _lastOpenCodeCliStart = Date.now();
    }

    const termName = `AutoDev: ${providerCfg.label}`;
    launcher.launch(cmd, termName, root);
    log(`Sent to ${termName}: ${cmd}`);

    if (providerId === 'claude-cli' && !resolvedSessionId) {
      const jsonlSession = findLatestClaudeSession(root);
      if (jsonlSession) { captureAndSaveSessionId(root, providerId, jsonlSession); }
    }
    return;
  }
}
