import * as fs from 'fs';
import * as path from 'path';
import { ProviderId } from '../providers';

// ---------------------------------------------------------------------------
// AutoDev settings — pure Node.js loader (no VS Code dependency).
// The VS Code extension's settings.ts re-exports these and adds UI helpers.
// ---------------------------------------------------------------------------

export interface AutodevSettings {
  provider: ProviderId;
  /** Full WS URL with token+endpoint encoded: wss://host/ws?token=xxx&endpoint=slug */
  wsUrl: string;
  /** Derived from wsUrl (or set directly for backward compat). */
  serverBaseUrl: string;
  serverApiKey: string;
  webhookSlug: string;
  discordToken: string;
  discordChannelId: string;
  discordOwners: string;
  loopInterval: number;
  taskTimeoutMinutes: number;
  taskCheckInMinutes: number;
  retryOnTimeout: boolean;
  autoResetPendingTasks: boolean;
  profilePath: string;
  todoPath: string;
  resumeSession: boolean;
  vncEnabled: boolean;
  vncHost: string;
  vncPort: number;
  vncPassword: string;
  rdpEnabled: boolean;
  rdpHost: string;
  rdpPort: number;
  rdpUsername: string;
  rdpPassword: string;
  rdpDomain: string;
  /** Public WSS URL for guacamole-lite (e.g. wss://myhost.com/guac-ws). If empty, falls back to ws://<rdpHost>:4567 */
  rdpGuacWsUrl: string;
  enableFileBrowser: boolean;
  gitEnabled: boolean;
  /**
   * Opt-in: honor `mcp_update` frames pushed over the WS channel. When false
   * (default), inbound mcp_update frames are ignored. Writing remote-supplied
   * MCP server config spawns stdio child processes on restart, so this is a
   * code-execution surface and must be explicitly enabled (mirrors
   * enableFileBrowser / gitEnabled). Even when enabled, entries are validated.
   */
  mcpUpdateEnabled: boolean;
  /**
   * Opt-in: honor `skill_update` frames pushed over the WS channel. When false
   * (default), inbound skill_update frames are ignored. Writing remote-supplied
   * skills drops instruction files into `.claude/skills/` that a running Claude
   * agent live-reads, so it is an instruction-injection surface and must be
   * explicitly enabled (mirrors mcpUpdateEnabled). Even when enabled, each skill
   * is validated (slug shape, size caps, workspace path containment).
   */
  skillUpdateEnabled: boolean;
  hooksEnabled: boolean;
  hooksScope: 'project' | 'global';
  openCodeHooksEnabled: boolean;
  /**
   * If true, the VS Code extension auto-starts the task loop on activation
   * (when a wsUrl is set). Useful for `autodev --setup-url=… --ide=vscode`
   * where the user expects the agent to come online immediately on launch.
   * Default false — opt in via .autodev/settings.json (the CLI sets it true).
   */
  autoStartLoop: boolean;
  /**
   * Optional model override for Copilot CLI. When set, passes `--model=<value>`
   * to the `copilot` command. Leave empty to use the CLI default model.
   * Example values: `claude-sonnet-4.6`, `gpt-5.4`, `gemini-2.5-pro`.
   */
  copilotModel: string;
  /**
   * Optional model override for Claude CLI. When set, passes `--model <value>`
   * to the `claude` command. Leave empty to use the CLI default.
   * Example values: `best`, `sonnet`, `opus`, `haiku`.
   */
  claudeModel: string;
  /**
   * Optional model override for OpenCode CLI. When set, passes `--model=<value>`
   * to the `opencode` command. Leave empty to use the CLI default.
   * Example values: `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`.
   */
  opencodeModel: string;
  /**
   * Optional human-readable session display NAME (not the session id). When set
   * it is shown in pixel-office for this agent and passed to providers that
   * support a native session title: opencode `--title`, copilot `--name`.
   */
  sessionName: string;
  /**
   * Optional model override for Grok TUI. When set, passes `-m <value>` to
   * the `grok` command. Leave empty (the default) to force NO model, so grok
   * uses the account's own default. Run `grok models` to list valid models.
   */
  grokModel: string;
  /**
   * When true, writes `setCacheKey: true` into the provider options of the
   * project-level `opencode.json`, enabling prompt/model caching.
   */
  opencodeCacheEnabled: boolean;
  /**
   * Per-project MCP server definitions managed by autodev. Stored in the
   * standard `mcpServers` shape (`{ <name>: { command, args, env } }`) so
   * users can paste server snippets verbatim from MCP docs (e.g.
   * mcp-atlassian for Jira). On save, the extension fans these out to every
   * provider's project-local config (.mcp.json, .claude/settings.local.json,
   * opencode.json, .vscode/mcp.json) alongside the autodev defaults.
   */
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>;
  /**
   * Names of built-in MCP servers (from DEFAULT_MCP_SERVERS) that the user
   * has explicitly disabled. Built-ins default to enabled when not listed.
   */
  disabledBuiltinMcp: string[];
  /**
   * MCP-only agent (no autodev loop). When true, the auto-attached office
   * built-in is wired to the OPERATOR MCP (`autodev mcp-operate` →
   * `…/api/office-mcp`) instead of the A2A-only remote (`…/api/mcp/a2a`).
   *
   * Why it matters: the A2A endpoint carries messaging only — no presence
   * write, no task/report tools — which is fine for a loop agent (it has its
   * own WebSocket presence + task loop) but leaves a pure-MCP client offline
   * with no way to pull work. The operator bridge registers presence (its own
   * socket + office-mcp polling) and exposes the full agent toolkit (tasks,
   * report, status, whoami) plus A2A, so an MCP-only client — opencode/Kimi,
   * Claude Code, any MCP client — becomes a first-class office agent.
   *
   * Loop agents leave this false (the default) and keep the A2A remote.
   */
  mcpOnly: boolean;
  /** Fallback provider to use when the main provider hits a rate limit. Empty string = disabled. */
  fallbackProvider: ProviderId;
  /** Whether to automatically switch to fallbackProvider on rate limit instead of pausing. */
  fallbackProviderEnabled: boolean;
  /**
   * Ordered list of profile section IDs to include when assembling AGENT_PROFILE.md.
   * Each ID corresponds to a file in `media/profile/`. An empty array means all
   * sections are included (the default). Use the ProfileBuilder sidebar tab to manage.
   */
  enabledProfileSections: string[];
  /**
   * Additional `@path` references appended to AGENT_PROFILE.md after the section index.
   * Each entry is a workspace-relative (or absolute) path. The `@` prefix is added
   * automatically if missing. One path per entry.
   */
  customProfileRefs: string[];
  /**
   * When true, the task loop automatically runs /compact every
   * `autoCompactInterval` completed tasks to keep the context window lean.
   */
  autoCompact: boolean;
  /** How many completed tasks to wait between automatic /compact runs. Default 5. */
  autoCompactInterval: number;
  /**
   * OpenCode provider-level HTTP timeout in milliseconds.
   * Written to opencode.json under provider.*.options.timeout.
   * 0 = use OpenCode default (300000 / 5 min).
   */
  opencodeTimeout: number;
  /**
   * OpenCode provider-level chunk timeout in milliseconds (max gap between
   * streaming chunks before the request is considered stalled).
   * Written to opencode.json under provider.*.options.chunkTimeout.
   * 0 = use OpenCode default.
   */
  opencodeChunkTimeout: number;
  /**
   * Reset the agent session every N completed tasks (0 = disabled).
   * Only active when resumeSession is true.
   * When triggered, the agent is asked to summarise to SUMMARY.md before the
   * session ID is cleared so the next task starts a fresh session.
   */
  resetSessionEveryNTurns: number;
  /**
   * How many times the loop will dispatch the same task before giving up and
   * force-marking it done. Prevents a single stuck task from blocking the queue
   * indefinitely. Default: 3. Set to 0 to disable (never force-done).
   */
  maxTaskAttempts: number;
  /**
   * Move completed [x] tasks from TODO.md into DONE.md every N
   * completed tasks (0 = disabled). Keeps the active TODO file short.
   */
  pruneTodoEveryNTasks: number;
  /**
   * Trigger the auto-learn / journal review cycle every N completed tasks
   * (0 = disabled). The agent reads JOURNAL.md, extracts patterns, updates
   * LESSONS.md, and optionally creates skill files. Default: 0.
   */
  journalLearnEveryNTasks: number;
  /**
   * Run /compact on the active session every N completed tasks (0 = disabled).
   * Complements the existing autoCompact/autoCompactInterval toggle — use one
   * or the other; both can be active simultaneously.
   */
  compactEveryNTasks: number;
  /**
   * Prompt the agent to create/update a SKILLS.md file every N completed tasks.
   * 0 = disabled. The agent is asked to record reusable patterns, commands,
   * and learnings it has discovered into SKILLS.md before continuing.
   */
  skillEveryNTasks: number;
  /**
   * Prompt the agent to update SUMMARY.md every N completed tasks.
   * 0 = disabled. The agent is asked to merge new findings into SUMMARY.md
   * and update LESSONS.md with any corrections or repeat failures.
   */
  memoryEveryNTasks: number;
  /**
   * Prompt the agent to write a full project state summary to SUMMARY.md
   * every N completed tasks (more comprehensive than the memory update).
   * 0 = disabled.
   */
  summaryEveryNTasks: number;
  /**
   * Re-send the full agent profile (includeProfile=true) every N completed tasks.
   * 0 = only send on the first task of each loop start.
   * Useful to keep long-running agents on protocol even in resumed sessions.
   */
  profileEveryNTasks: number;
  /**
   * GitHub personal access token used by the Copilot TUI (SDK) provider.
   * Overrides the GITHUB_TOKEN / GH_TOKEN env vars and keytar lookup.
   * Required on Linux/headless machines where `copilot auth login` credentials
   * are not available in the system keyring.
   * The token needs the `copilot` scope (or a classic token with `read:user` + `copilot`).
   */
  copilotGithubToken: string;
  /** Upload an agent backup zip to pixel-office when the export_request WS message is received. */
  exportEnabled: boolean;
  /** Automatically upload a backup once per day (only active when exportEnabled is true). */
  exportDailyBackup: boolean;
  /** Agent database ID (set automatically when export_config is received from pixel-office). */
  agentId: string;
}

export const SETTINGS_DEFAULTS: AutodevSettings = {
  provider: 'claude-tui' as ProviderId,
  wsUrl: '',
  serverBaseUrl: '',
  serverApiKey: '',
  webhookSlug: '',
  discordToken: '',
  discordChannelId: '',
  discordOwners: '',
  loopInterval: 30,
  taskTimeoutMinutes: 30,
  taskCheckInMinutes: 20,
  retryOnTimeout: false,
  autoResetPendingTasks: true,
  profilePath: '',
  todoPath: '',
  resumeSession: false,
  vncEnabled: false,
  vncHost: '',
  vncPort: 5900,
  vncPassword: '',
  rdpEnabled: false,
  rdpHost: '',
  rdpPort: 3389,
  rdpUsername: '',
  rdpPassword: '',
  rdpDomain: '',
  rdpGuacWsUrl: '',
  enableFileBrowser: false,
  gitEnabled: false,
  mcpUpdateEnabled: false,
  skillUpdateEnabled: false,
  hooksEnabled: false,
  hooksScope: 'project',
  openCodeHooksEnabled: false,
  autoStartLoop: false,
  copilotModel: '',
  claudeModel: '',
  opencodeModel: '',
  sessionName: '',
  grokModel: '',
  opencodeCacheEnabled: false,
  mcpServers: {},
  disabledBuiltinMcp: [],
  mcpOnly: false,
  fallbackProvider: 'opencode-cli' as ProviderId,
  fallbackProviderEnabled: false,
  enabledProfileSections: [],
  customProfileRefs: [],
  autoCompact: false,
  autoCompactInterval: 5,
  opencodeTimeout: 0,
  opencodeChunkTimeout: 0,
  resetSessionEveryNTurns: 0,
  maxTaskAttempts: 3,
  pruneTodoEveryNTasks: 0,
  journalLearnEveryNTasks: 0,
  profileEveryNTasks: 0,
  compactEveryNTasks: 0,
  skillEveryNTasks: 0,
  memoryEveryNTasks: 0,
  summaryEveryNTasks: 0,
  copilotGithubToken: '',
  exportEnabled: false,
  exportDailyBackup: false,
  agentId: '',
};

/**
 * Parse a full WS URL (wss://host/ws?token=xxx&endpoint=slug) into the three
 * legacy fields.  Returns null if the URL is empty or not a WS scheme.
 */
export function parseWsUrl(wsUrl: string): { serverBaseUrl: string; serverApiKey: string; webhookSlug: string } | null {
  if (!wsUrl || (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://'))) { return null; }
  try {
    const u = new URL(wsUrl);
    const token    = u.searchParams.get('token')    ?? '';
    const endpoint = u.searchParams.get('endpoint') ?? '';
    u.search = '';
    return { serverBaseUrl: u.toString(), serverApiKey: token, webhookSlug: endpoint };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings file location.
//
// Canonical:  <root>/.autodev/settings.json
// Legacy:     <root>/.vscode/autodev.json   (still read for back-compat)
//
// Reads prefer the canonical file. If it is missing but the legacy file
// exists, the legacy file is read transparently. New writes always go to the
// canonical path so a workspace migrates automatically on the next save.
// ---------------------------------------------------------------------------

export const NEW_SETTINGS_REL_PATH = '.autodev/settings.json';
export const LEGACY_SETTINGS_REL_PATH = '.vscode/autodev.json';

/** Path that should be used for writes (always the new canonical location). */
export function settingsWritePath(root: string): string {
  return path.join(root, '.autodev', 'settings.json');
}

/** Path that should be used for reads — canonical if present, else legacy. */
export function settingsReadPath(root: string): string {
  const canonical = path.join(root, '.autodev', 'settings.json');
  if (fs.existsSync(canonical)) { return canonical; }
  const legacy = path.join(root, '.vscode', 'autodev.json');
  if (fs.existsSync(legacy)) { return legacy; }
  return canonical; // doesn't exist; callers handle missing-file
}

/**
 * Field names the docs and the office UI have long told users to write by hand,
 * mapped to the ones this loader actually reads.
 *
 * They never matched. The "Manual (raw creds)" instructions
 * (AgentConnectCommands.vue, docs/CONNECT-A-LOCAL-AGENT.md) say to write
 * `officeWsUrl` / `apiKey` / `slug`; the loader only ever read `wsUrl` /
 * `serverApiKey` / `webhookSlug`. Following the documented steps therefore
 * produced a settings.json the CLI silently ignored: no binding, no office, and
 * NO ERROR — the agent just sat there looking fine.
 *
 * Accepting them as aliases (rather than only correcting the docs) is deliberate:
 * it repairs every settings.json already written from those instructions, without
 * the user having to discover that the guidance was wrong.
 *
 * Canonical keys always win; an alias only fills a field left empty.
 */
const SETTINGS_ALIASES: Record<string, keyof AutodevSettings> = {
  officeWsUrl: 'wsUrl',
  apiKey: 'serverApiKey',
  slug: 'webhookSlug',
};

/** Load settings, preferring `.autodev/settings.json` and falling back to the legacy `.vscode/autodev.json`. */
export function loadSettingsForRoot(root: string): AutodevSettings {
  try {
    const file = settingsReadPath(root);
    if (!fs.existsSync(file)) { return { ...SETTINGS_DEFAULTS }; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutodevSettings>;
    const merged = { ...SETTINGS_DEFAULTS, ...raw };

    // Fold in the documented-but-unread names before anything derives from them.
    const rawAny = raw as Record<string, unknown>;
    for (const [alias, canonical] of Object.entries(SETTINGS_ALIASES)) {
      const v = rawAny[alias];
      if (typeof v === 'string' && v !== '' && !merged[canonical]) {
        (merged as Record<string, unknown>)[canonical] = v;
      }
    }
    // If wsUrl is set, derive the three legacy fields from it (wsUrl takes priority).
    const parsed = parseWsUrl(merged.wsUrl);
    if (parsed) {
      merged.serverBaseUrl = parsed.serverBaseUrl;
      merged.serverApiKey  = parsed.serverApiKey;
      merged.webhookSlug   = parsed.webhookSlug;
    }
    return merged;
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}
