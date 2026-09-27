import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderId, PROVIDERS } from './providers';
import { IProcessLauncher } from './core/adapters';
import { getSessionId, captureAndSaveSessionId, getSessionClearedAt, AGENT_PROFILE_FILE, newMessageOutput, autodevDir } from './sessionState';
import { loadSettingsForRoot } from './core/settingsLoader';
import { buildClaudeCliCommand, findLatestClaudeSession, probeClaudeSession, setClaudeSessionName } from './providers/claudeCliProvider';
import { buildCopilotCliCommand, probeCopilotSession } from './providers/copilotCliProvider';
import { buildOpenCodeCliCommand, getLatestOpenCodeSessionId } from './providers/opencodeCliProvider';
import { sendClaudeTuiPrompt } from './providers/claudeTuiProvider';
import { sendCopilotSdkPrompt, getLatestCopilotSdkSessionId, setCopilotSettingsToken } from './providers/copilotSdkProvider';
import { sendOpencodeSdkPrompt, opencodeCliPersistentEnabled } from './providers/opencodeSdkProvider';
import { sendGrokTuiPrompt } from './providers/grokTuiProvider';
import { getGrokLatestSessionId } from './providers/grok/sessions';
import { isOpenCodeHooksInstalled, installOpenCodeHooks } from './openCodeHooksManager';
import { teeCommand, withExitFile, wrapWithSyntheticHooks, writeCombinedFile } from './core/commandHelpers';
import { rebuildProfile } from './messageBuilder';
import { providerRegistry } from './core/provider/ProviderRegistry';
import { DispatchRequest } from './core/provider/contract';

// Re-export session helpers so taskLoop.ts imports don't need to change.
export {
  findLatestClaudeSession,
  setClaudeSessionName,
  getClaudeSessionCursor,
  parseClaudeStateSince,
  hasClaudeEndTurnSince,
  readClaudeOutputSince,
  ClaudeSessionState,
} from './providers/claudeCliProvider';



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



function ensureProjectGitignore(root: string, entry: string): void {
  const gitignorePath = path.join(root, '.gitignore');
  try {
    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (content.split('\n').map(l => l.trim()).includes(entry)) { return; }
    if (content.length > 0 && !content.endsWith('\n')) { content += '\n'; }
    fs.writeFileSync(gitignorePath, content + `${entry}\n`, 'utf8');
  } catch { /* ignore */ }
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
    // MESSAGE.md sits beside program.md in .autodev/ (do NOT derive it by string
    // -replacing the profile filename — that broke when AGENT_PROFILE.md → program.md).
    const messageFile = messageFilePath ?? path.join(root, '.autodev', 'MESSAGE.md');
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
    // Test/tool artifact output dirs — junk written by QA swarms, Playwright MCP,
    // and test runners; never source. Keep conservative: only artifact dirs.
    for (const entry of [
      '.playwright-mcp/', 'qa/', 'test-results/', 'playwright-report/',
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

    // BOTH grok variants are persistent (resume their own workspace session so
    // context accumulates across turns): grok-tui always was, and grok-cli now
    // resumes too (user-requested). Both ignore the global resumeSession toggle —
    // grok persistence is independent of it. Every other provider honors it.
    const isGrok = providerId === 'grok-tui' || providerId === 'grok-cli';
    const wantResume = isGrok ? true : settings.resumeSession;
    const storedSessionId = wantResume ? getSessionId(root, providerId) : undefined;

    let resolvedSessionId = storedSessionId;
    // grok resolves its fallback regardless of settings.resumeSession (persistence
    // is intrinsic to the two variants); everyone else only when resumeSession is on.
    if (!resolvedSessionId && (settings.resumeSession || isGrok)) {
      if (providerId === 'claude-cli') {
        resolvedSessionId = await probeClaudeSession(root, log);
      } else if (providerId === 'copilot-cli') {
        resolvedSessionId = await probeCopilotSession(root, log);
      } else if (providerId === 'opencode-cli') {
        // Use session list (filters by directory) with notBefore to skip
        // sessions created before the last "New Session" clear.
        const clearedAt = getSessionClearedAt(root, 'opencode-cli');
        resolvedSessionId = await getLatestOpenCodeSessionId(root, log, clearedAt);
      } else if (isGrok) {
        // Disk-detection fallback: the newest grok session dir on disk for this
        // cwd (works even when session-state.json is absent/stale, and even before
        // grok's shared sqlite index catches up). Mirrors resolveSession().
        resolvedSessionId = getGrokLatestSessionId(root);
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

    // Build the combined profile+message file once and assemble the immutable
    // dispatch DTO. The resolved IProvider strategy decides what to do with it
    // (build a shell command, or spawn in-process) — no per-provider switch.
    // SAFETY: writeCombinedFile reads PROGRAM.md when includeProfile — PROGRAM.md is
    // written on the profile build (loop start / Save & Rebuild), no longer every
    // turn. If it is somehow missing here (SDK path that never ran buildMessage, or
    // a deleted file), build it once so writeCombinedFile never throws. Idempotent.
    if (includeProfile && !fs.existsSync(agentProfileFile)) {
      try { rebuildProfile(root); }
      catch (err) {
        // Don't swallow silently — a failed rebuild here is exactly how PROGRAM.md
        // ends up missing at dispatch. Log one clear line; writeCombinedFile still
        // dispatches (agent picks the profile up via the AGENTS.md pointer).
        log(`⚠️ rebuildProfile failed at dispatch (PROGRAM.md may be missing this turn): ${(err as Error)?.message ?? String(err)}`);
      }
    }
    const combinedFile = writeCombinedFile(root, agentProfileFile, messageFile, includeProfile);
    const provider = providerRegistry.get(providerId);
    const req: DispatchRequest = {
      root, agentProfileFile, messageFile, combinedFile,
      resolvedSessionId, includeProfile, settings, stdoutFile, exitFile,
    };

    // Enforce a minimum cooldown between consecutive opencode-cli process starts
    // to avoid racing a still-disposing previous server (immediate STOP). Skipped
    // when opencode-cli runs PERSISTENT (Phase 2): there is no per-turn process
    // start to space out — the in-process server is reused across turns.
    if (providerId === 'opencode-cli' && !opencodeCliPersistentEnabled()) {
      const elapsed = Date.now() - _lastOpenCodeCliStart;
      if (elapsed < OPENCODE_CLI_COOLDOWN_MS && _lastOpenCodeCliStart > 0) {
        const wait = OPENCODE_CLI_COOLDOWN_MS - elapsed;
        log(`⏳ opencode-cli cooldown: waiting ${Math.round(wait / 1000)}s before next start…`);
        await _sleep(wait);
      }
      _lastOpenCodeCliStart = Date.now();
    }

    const outcome = await provider.dispatch(req, { log, launcher, showOutput });

    if (outcome.command) {
      // CLI provider: launch the shell command via the injected launcher.
      const termName = `AutoDev: ${providerCfg.label}`;
      launcher.launch(outcome.command, termName, root);
      log(`Sent to ${termName}: ${outcome.command}`);
      if (providerId === 'claude-cli' && !resolvedSessionId) {
        const jsonlSession = findLatestClaudeSession(root);
        if (jsonlSession) { captureAndSaveSessionId(root, providerId, jsonlSession); }
      }
    } else {
      // In-process (sdk/tui) provider: already spawned inside dispatch().
      log(`${providerCfg.label}: prompt dispatched (session=${resolvedSessionId ?? 'new'})`);
    }
    return;
  } else {
    // Defensive fail-loud gate (matches providerRegistry.get()'s throw-on-unknown
    // style). Today all providers set isCli:true so this is unreachable; a future
    // isCli:false provider would otherwise silently return with no output and no
    // error. Surface it loudly instead of a silent no-op.
    throw new Error(`Provider '${providerId}' has isCli=false but no dispatch path is implemented`);
  }
}
