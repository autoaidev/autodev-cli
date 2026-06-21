import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Hooks manager — installs/removes autodev command hooks for both:
//   - Claude Code        → <root>/.claude/settings.json   (PascalCase events)
//   - Copilot CLI        → <root>/.github/copilot/settings.json (camelCase events)
// Each hook appends its stdin JSON payload (one event) as a JSONL line to
// ~/.autodev/hooks-events.jsonl. The task-loop polls that file every 10 s and
// forwards events via WebSocket.
//
// Hooks bodies are Node.js (not Python) — autodev already requires Node.js,
// so we drop the python3 dependency.
// ---------------------------------------------------------------------------

const AUTODEV_MARKER = '__autodev_hooks__';

// Claude Code uses PascalCase event names.
const CLAUDE_HOOK_EVENTS = [
  // Tool lifecycle
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  // Session lifecycle
  'SessionStart',
  'SessionEnd',
  'Setup',
  'Stop',
  'StopFailure',
  // Subagent / teammate
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  // Permissions
  'PermissionRequest',
  'PermissionDenied',
  // User prompt
  'UserPromptSubmit',
  // Tasks
  'TaskCreated',
  'TaskCompleted',
  // Context / workspace
  'CwdChanged',
  'FileChanged',
  'InstructionsLoaded',
  'ConfigChange',
  // Compaction
  'PreCompact',
  'PostCompact',
  // Elicitation
  'Elicitation',
  'ElicitationResult',
  // Worktree
  'WorktreeCreate',
  'WorktreeRemove',
  // General
  'Notification',
] as const;

// Copilot CLI uses camelCase event names. Full list per
// https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-cli-reference/cli-hooks-reference
const COPILOT_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'agentStop',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'permissionRequest',
  'notification',
  'errorOccurred',
] as const;

/**
 * Path of the JSONL sink for a given workspace.
 *
 * Per-workspace, NOT homedir. When two VS Code instances run on the same
 * machine, they share `os.homedir()` — so a homedir-scoped sink causes both
 * pollers to see (and forward, attributed to themselves) every hook from
 * every instance. The result was hooks from `tester-1` showing up under
 * `A1` in pixel-office because A1's poller read the line first. Scoping
 * the sink to the workspace avoids the cross-talk entirely.
 */
export function hooksJsonlPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autodev', 'hooks-events.jsonl');
}

// ---------------------------------------------------------------------------
// Hook scripts — written to <workspaceRoot>/.autodev/scripts/ once per
// workspace. Using real files avoids all shell-quoting issues (no node -e
// with embedded JSON, no PowerShell quote-stripping, no base64 tricks).
// ---------------------------------------------------------------------------

const HOOK_SCRIPTS_MARKER = '// __autodev_hooks_script__';

/** Content of hook-append.js — reads stdin JSON, optionally overrides
 *  hook/provider fields, then appends to the JSONL sink.
 *  Args: <jsonlPath> [injectEvent] [injectProvider] */
const HOOK_APPEND_SCRIPT = `${HOOK_SCRIPTS_MARKER}
// Reads one JSON event from stdin and appends it to <jsonlPath>.
// Args: <jsonlPath> [injectEvent] [injectProvider]
// Compatible with both CJS and ESM host packages (uses createRequire shim).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const [,, jsonlPath, injectEvent, injectProvider] = process.argv;
let s = '';
process.stdin.on('data', c => s += c).on('end', () => {
  let d;
  try { d = JSON.parse(s); } catch (e) { d = { _raw: s.replace(/[\\r\\n]+/g, ' ') }; }
  if (injectEvent)    { d.hook     = injectEvent; }
  if (injectProvider) { d.provider = injectProvider; }
  d.timestamp = new Date().toISOString();
  const fs = require('fs'), p = require('path');
  fs.mkdirSync(p.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(d) + '\\n');
});
`;

/** Content of hook-event.js — reads a payload from a temp JSON file,
 *  appends it to the JSONL sink, then deletes the temp file.
 *  Args: <jsonlPath> <payloadFile> */
const HOOK_EVENT_SCRIPT = `${HOOK_SCRIPTS_MARKER}
// Reads a synthetic event payload from <payloadFile>, appends to <jsonlPath>,
// then deletes the temp payload file.
// Args: <jsonlPath> <payloadFile>
// Compatible with both CJS and ESM host packages (uses createRequire shim).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const [,, jsonlPath, payloadFile] = process.argv;
const fs = require('fs'), p = require('path');
try {
  const d = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  d.timestamp = new Date().toISOString();
  fs.mkdirSync(p.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(d) + '\\n');
} finally {
  try { fs.unlinkSync(payloadFile); } catch { }
}
`;

function hookScriptsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autodev', 'scripts');
}

/** Write (or overwrite) the two hook script files to .autodev/scripts/.
 *  Safe to call on every install — idempotent and fast. */
function ensureHookScripts(workspaceRoot: string): void {
  const dir = hookScriptsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook-append.mjs'), HOOK_APPEND_SCRIPT, 'utf8');
  fs.writeFileSync(path.join(dir, 'hook-event.mjs'),  HOOK_EVENT_SCRIPT,  'utf8');
}

/** Quote a file path for use in a shell command (handles spaces).  Uses
 *  forward slashes so the path works in both bash and PowerShell on Windows. */
function shellQuotePath(p_: string): string {
  return `"${p_.replace(/\\/g, '/')}"`;
}

/** Use the exact Node runtime running the extension host.
 * Copilot hook subprocesses can have a minimal PATH (especially on headless
 * hosts), so relying on bare `node` may fail and drop hook events. */
function nodeExec(): string {
  return shellQuotePath(process.execPath);
}

/** Shell command for Claude Code — Claude already includes hook_event_name in
 *  the stdin payload, so we don't need to inject anything. */
function claudeHookCommand(workspaceRoot: string): string {
  const script  = path.join(hookScriptsDir(workspaceRoot), 'hook-append.mjs');
  const jsonl   = hooksJsonlPath(workspaceRoot);
  return `${nodeExec()} ${shellQuotePath(script)} ${shellQuotePath(jsonl)}`;
}

/** Shell command for one Copilot CLI event — Copilot doesn't include the
 *  event name in stdin, so we pass it as an argument. */
function copilotHookCommand(eventName: string, workspaceRoot: string): string {
  const script  = path.join(hookScriptsDir(workspaceRoot), 'hook-append.mjs');
  const jsonl   = hooksJsonlPath(workspaceRoot);
  return `${nodeExec()} ${shellQuotePath(script)} ${shellQuotePath(jsonl)} ${JSON.stringify(eventName)} "copilot-cli"`;
}

/** Same command as copilotHookCommand but uses Windows-native path separators
 *  so that PowerShell can execute it without WSL path translation issues.
 *  On Windows, copilot runs "bash" hooks via WSL which cannot resolve h:/...
 *  paths; the "powershell" field runs natively and handles them correctly. */
function copilotPowershellHookCommand(eventName: string, workspaceRoot: string): string {
  // PowerShell handles forward-slash quoted paths fine — same command string.
  return copilotHookCommand(eventName, workspaceRoot);
}

/** Returns a shell command that synthesises a hook event with no stdin payload.
 *  Writes the payload to a small temp JSON file in .autodev/scripts/ so that
 *  no shell quoting of JSON is required (avoids PowerShell stripping quotes).
 *  `workspaceRoot` controls which workspace's JSONL sink the hook writes to. */
export function getManualHookCmd(provider: string, hookEvent: string, workspaceRoot: string, sessionName?: string): string {
  ensureHookScripts(workspaceRoot);
  const payload = { hook: hookEvent, provider, _session_name: sessionName ?? '' };
  // Write payload to a temp file — avoids any shell quoting of JSON
  const scriptsDir = hookScriptsDir(workspaceRoot);
  fs.mkdirSync(scriptsDir, { recursive: true });
  const payloadFile = path.join(scriptsDir, `evt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf8');
  const script = path.join(scriptsDir, 'hook-event.mjs');
  const jsonl  = hooksJsonlPath(workspaceRoot);
  return `${nodeExec()} ${shellQuotePath(script)} ${shellQuotePath(jsonl)} ${shellQuotePath(payloadFile)}`;
}

// ---------------------------------------------------------------------------
// Claude Code hooks  (.claude/settings.json)
// ---------------------------------------------------------------------------

function claudeSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'settings.json');
}

function readJson(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

/** Hook events that were once registered by autodev but have since been removed from Claude Code. */
const OBSOLETE_HOOK_EVENTS = ['PostToolBatch', 'UserPromptExpansion'] as const;

/** Remove autodev entries for any obsolete or unrecognised hook events from a hooks object in-place. */
function purgeObsoleteHooks(hooks: Record<string, any[]>): void {
  for (const ev of OBSOLETE_HOOK_EVENTS) {
    if (!hooks[ev]) { continue; }
    hooks[ev] = hooks[ev].filter((g: any) => !g[AUTODEV_MARKER]);
    if (hooks[ev].length === 0) { delete hooks[ev]; }
  }
}

/**
 * True if the entry's command writes to *this* workspace's JSONL sink.
 * Legacy entries from <= v1.0.71 wrote to `os.homedir()/.autodev/...` (shared
 * across every VS Code instance on the host) — we treat those as not
 * installed so the install flow naturally migrates them on next call.
 */
function isCurrentClaudeEntry(group: any, workspaceRoot: string): boolean {
  if (!group || group[AUTODEV_MARKER] !== true) return false;
  const cmd = group.hooks?.[0]?.command;
  if (typeof cmd !== 'string') return false;
  const expectedSink = hooksJsonlPath(workspaceRoot).replace(/\\/g, '/');
  const expectedNode = process.execPath.replace(/\\/g, '/');
  // Also require the .mjs extension so legacy .js installs are re-migrated.
  return cmd.includes(JSON.stringify(expectedSink))
    && cmd.includes('hook-append.mjs')
    && cmd.includes(expectedNode);
}

export function areClaudeHooksInstalled(workspaceRoot: string): boolean {
  const filePath = claudeSettingsPath(workspaceRoot);
  const raw = readJson(filePath);
  const hooks = raw?.hooks ?? {};

  // Silently clean up obsolete entries whenever we check
  const hadObsolete = OBSOLETE_HOOK_EVENTS.some(ev => (hooks[ev] ?? []).some((g: any) => g[AUTODEV_MARKER]));
  if (hadObsolete && raw?.hooks) {
    purgeObsoleteHooks(raw.hooks);
    if (Object.keys(raw.hooks).length === 0) { delete raw.hooks; }
    try { fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8'); } catch { /* ignore */ }
  }

  // Collect every autodev-marked group across all events
  const allAutodev = CLAUDE_HOOK_EVENTS.flatMap(ev =>
    ((hooks[ev] ?? []) as any[]).filter(g => g[AUTODEV_MARKER] === true)
  );
  if (allAutodev.length === 0) return false;
  // Treat as "not installed" if ANY autodev entry is stale (legacy
  // homedir-pointing form, or any other shape) so the migration step
  // re-runs and overwrites the lot with the current per-workspace form.
  return allAutodev.every(g => isCurrentClaudeEntry(g, workspaceRoot));
}

export function installClaudeHooks(workspaceRoot: string): void {
  ensureHookScripts(workspaceRoot);
  const filePath = claudeSettingsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const raw = readJson(filePath);
  const hooks = raw.hooks ?? {};

  purgeObsoleteHooks(hooks);

  const claudeCmd = claudeHookCommand(workspaceRoot);
  for (const ev of CLAUDE_HOOK_EVENTS) {
    const groups = ((hooks[ev] ?? []) as any[]).filter(g => !g[AUTODEV_MARKER]);
    groups.push({
      [AUTODEV_MARKER]: true,
      matcher: '',
      hooks: [{ type: 'command', command: claudeCmd }],
    });
    hooks[ev] = groups;
  }

  raw.hooks = hooks;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');
}

export function uninstallClaudeHooks(workspaceRoot: string): void {
  const filePath = claudeSettingsPath(workspaceRoot);
  const raw = readJson(filePath);
  if (!raw.hooks) { return; }

  purgeObsoleteHooks(raw.hooks);

  for (const ev of CLAUDE_HOOK_EVENTS) {
    if (!raw.hooks[ev]) { continue; }
    raw.hooks[ev] = (raw.hooks[ev] as any[]).filter(g => !g[AUTODEV_MARKER]);
    if (raw.hooks[ev].length === 0) { delete raw.hooks[ev]; }
  }

  if (Object.keys(raw.hooks).length === 0) { delete raw.hooks; }
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Copilot CLI hooks  (.github/copilot/settings.json)
//
// Copilot CLI loads repo settings from `.github/copilot/settings.json` and
// `.github/copilot/settings.local.json`. The `hooks` field there has the
// shape:
//   { "<eventName>": [ { type, bash, powershell?, cwd?, timeoutSec? }, ... ] }
// Copilot doesn't support a per-entry "marker" field like Claude does (it
// validates each command strictly), so we identify our own entries by
// inspecting the `bash` command for our HOOK_COMMAND fingerprint.
// ---------------------------------------------------------------------------

function copilotSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.github', 'copilot', 'settings.json');
}

/**
 * True if the entry was installed by autodev (matches our HOOK_COMMAND, in
 * either the legacy homedir form or the per-workspace form). The legacy
 * command built the path via `p.join(h,".autodev","hooks-events.jsonl")` —
 * separate strings, no slash between them — so a literal `.autodev/...`
 * substring check would miss it. We match on the basename instead, which
 * appears in both forms (legacy as a separate quoted string, current as
 * part of the JSON-stringified absolute path).
 */
function isAutodevCopilotEntry(entry: any): boolean {
  const cmd = entry?.bash ?? entry?.powershell ?? '';
  return typeof cmd === 'string'
    && cmd.includes('hooks-events.jsonl')
    && cmd.includes('.autodev');
}

/** True if the entry's bash/powershell command writes to *this* workspace's JSONL sink. */
function isCurrentCopilotEntry(entry: any, workspaceRoot: string): boolean {
  if (!isAutodevCopilotEntry(entry)) return false;
  const expectedSink = hooksJsonlPath(workspaceRoot).replace(/\\/g, '/');
  const expectedNode = process.execPath.replace(/\\/g, '/');
  const cmd = entry?.bash ?? entry?.powershell ?? '';
  // Also require the .mjs extension so legacy .js installs are re-migrated.
  // Also require the powershell field (added in v1.0.218) so Windows installs
  // without it are treated as stale and re-installed with both fields.
  return typeof cmd === 'string'
    && cmd.includes(JSON.stringify(expectedSink))
    && cmd.includes('hook-append.mjs')
    && cmd.includes(expectedNode)
    && typeof entry?.powershell === 'string';
}

export function areCopilotHooksInstalled(workspaceRoot: string): boolean {
  const filePath = copilotSettingsPath(workspaceRoot);
  const raw = readJson(filePath);
  const hooks = raw?.hooks ?? {};
  const allAutodev = COPILOT_HOOK_EVENTS.flatMap(ev =>
    ((hooks[ev] ?? []) as any[]).filter(isAutodevCopilotEntry)
  );
  if (allAutodev.length === 0) return false;
  // Same migration trigger as Claude: any stale entry → reinstall.
  return allAutodev.every(e => isCurrentCopilotEntry(e, workspaceRoot));
}

export function installCopilotHooks(workspaceRoot: string): void {
  ensureHookScripts(workspaceRoot);
  const filePath = copilotSettingsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const raw = readJson(filePath);
  const hooks = raw.hooks ?? {};

  for (const ev of COPILOT_HOOK_EVENTS) {
    const existing = ((hooks[ev] ?? []) as any[]).filter(e => !isAutodevCopilotEntry(e));
    existing.push({
      type: 'command',
      // bash: used by copilot on Linux/macOS (and by Git Bash on Windows)
      bash: copilotHookCommand(ev, workspaceRoot),
      // powershell: used by copilot on Windows — WSL bash cannot resolve
      // Windows drive-letter paths (h:/...) so we supply a native PS command.
      powershell: copilotPowershellHookCommand(ev, workspaceRoot),
      timeoutSec: 30,
    });
    hooks[ev] = existing;
  }

  raw.hooks = hooks;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');
}

export function uninstallCopilotHooks(workspaceRoot: string): void {
  const filePath = copilotSettingsPath(workspaceRoot);
  const raw = readJson(filePath);
  if (!raw.hooks) { return; }

  for (const ev of COPILOT_HOOK_EVENTS) {
    if (!raw.hooks[ev]) { continue; }
    raw.hooks[ev] = (raw.hooks[ev] as any[]).filter(e => !isAutodevCopilotEntry(e));
    if (raw.hooks[ev].length === 0) { delete raw.hooks[ev]; }
  }

  if (Object.keys(raw.hooks).length === 0) { delete raw.hooks; }
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Combined helpers — install/uninstall both Claude + Copilot in one call so
// the user doesn't have to think about which provider they're running.
// ---------------------------------------------------------------------------

export function installHooks(scope: 'project' | 'global', workspaceRoot: string): void {
  // Scope arg kept for backwards compatibility — always project now.
  void scope;
  installClaudeHooks(workspaceRoot);
  installCopilotHooks(workspaceRoot);
}

export function uninstallHooks(scope: 'project' | 'global', workspaceRoot: string): void {
  void scope;
  uninstallClaudeHooks(workspaceRoot);
  uninstallCopilotHooks(workspaceRoot);
}

export function areHooksInstalled(scope: 'project' | 'global', workspaceRoot: string): boolean {
  void scope;
  // Either side counts as "installed" — the UI shows a single combined state.
  return areClaudeHooksInstalled(workspaceRoot) || areCopilotHooksInstalled(workspaceRoot);
}
