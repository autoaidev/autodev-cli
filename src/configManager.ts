import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerManager, DEFAULT_MCP_SERVERS, McpServerEntry } from './mcpManager';
import { loadSettingsForRoot } from './core/settingsLoader';
import { loadProjectUserMcp, loadProjectAllMcp, saveProjectUserMcp, replaceProjectBuiltinMcp, isRemoteMcp, type McpJsonEntry, type McpJsonEntries } from './core/projectMcp';

// ---------------------------------------------------------------------------
// ConfigManager — applies permission/settings files for each CLI provider
// and syncs default MCP servers to all of them.
//
// Covers:
//   Claude CLI  : ~/.claude/settings.json  (permissions)
//                 <root>/.claude/settings.json  (project-level allow:*)
//   Copilot CLI : ~/.copilot/mcp-config.json  (MCP only — no extra perms)
//   OpenCode CLI: %APPDATA%/opencode/config.json  (permission: {"*":"allow"})
//                 <root>/opencode.json  (project-level)
//
// MCP entries are merged in via McpServerManager.addDefaults().
// This class is vscode-free so it can be tested or called independently.
// ---------------------------------------------------------------------------

/**
 * Where this workspace's Copilot MCP config lives.
 *
 * Copilot's own config (~/.copilot/mcp-config.json) is GLOBAL, so on a box with
 * several agents each sync clobbered the last and every copilot agent ended up
 * driving whichever workspace synced most recently. We therefore keep a
 * per-workspace file and hand it to copilot with `--additional-mcp-config @<file>`.
 *
 * Exported so the writer (syncProjectMcpServers) and the reader
 * (buildCopilotCliCommand) can never disagree about the path.
 */
export function copilotMcpConfigPath(root: string): string {
  return path.join(root, '.autodev', 'copilot-mcp.json');
}

export class ConfigManager {
  // -------------------------------------------------------------------------
  // Claude CLI
  // -------------------------------------------------------------------------

  /**
   * Write bypassPermissions to ~/.claude/settings.json and, if a workspace
   * root is provided, allow:* to <root>/.claude/settings.json.
   */
  static applyClaudePermissions(root?: string, log?: (m: string) => void): void {
    // User-level: bypass all permission prompts
    const userFile = path.join(os.homedir(), '.claude', 'settings.json');
    _mergeJson(userFile, (cfg) => {
      const perms = _obj(cfg['permissions']);
      perms['defaultMode'] = 'bypassPermissions';
      perms['skipDangerousModePermissionPrompt'] = true;
      cfg['permissions'] = perms;
    }, log, 'Claude user settings');

    // Project-level: allow all tools
    if (root) {
      const projectFile = path.join(root, '.claude', 'settings.json');
      _mergeJson(projectFile, (cfg) => {
        const perms = _obj(cfg['permissions']);
        perms['allow'] = ['*'];
        cfg['permissions'] = perms;
      }, log, 'Claude project settings');
    }
  }

  // -------------------------------------------------------------------------
  // OpenCode CLI
  // -------------------------------------------------------------------------

  /**
   * Write permission:{"*":"allow"} to the OpenCode user config and optionally
   * to <root>/opencode.json (project-level).
   */
  static applyOpenCodePermissions(root?: string, log?: (m: string) => void): void {
    // User-level config path reused from McpServerManager
    const userFile = McpServerManager.configPathFor('opencode-cli');
    _mergeJson(userFile, (cfg) => {
      cfg['permission'] = { '*': 'allow' };
    }, log, 'OpenCode user config');

    // Project-level
    if (root) {
      const projectFile = path.join(root, 'opencode.json');
      _mergeJson(projectFile, (cfg) => {
        // Preserve any existing provider/model keys, only touch permission
        cfg['permission'] = { '*': 'allow' };
      }, log, 'OpenCode project config');
    }
  }

  /**
   * Enable or disable `setCacheKey: true` for all provider sections in the
   * project-level `opencode.json`. When `enabled` is true, every existing
   * provider entry gets `options.setCacheKey = true` added. When false, the
   * key is deleted (options object is pruned if it becomes empty).
   */
  static applyOpenCodeCacheSettings(root: string, enabled: boolean, log?: (m: string) => void): void {
    const projectFile = path.join(root, 'opencode.json');
    _mergeJson(projectFile, (cfg) => {
      const provider = _obj(cfg['provider']);
      // Apply to every provider section that already exists in the file.
      // We don't create new provider entries — only touch what's there so
      // we don't accidentally set a key for a provider that isn't configured.
      for (const providerName of Object.keys(provider)) {
        const prov = _obj(provider[providerName]);
        if (enabled) {
          const opts = _obj(prov['options']);
          opts['setCacheKey'] = true;
          prov['options'] = opts;
        } else {
          const opts = prov['options'];
          if (opts && typeof opts === 'object') {
            delete (opts as Record<string, unknown>)['setCacheKey'];
            if (Object.keys(opts).length === 0) { delete prov['options']; }
          }
        }
        provider[providerName] = prov;
      }
      cfg['provider'] = provider;
    }, log, 'OpenCode cache settings');
  }

  /**
   * Apply `timeout` and `chunkTimeout` to every provider section in the
   * project-level `opencode.json`. Values of 0 mean "remove the key" so the
   * OpenCode default applies.
   */
  static applyOpenCodeTimeoutSettings(root: string, timeoutMs: number, chunkTimeoutMs: number, log?: (m: string) => void): void {
    const projectFile = path.join(root, 'opencode.json');
    _mergeJson(projectFile, (cfg) => {
      const provider = _obj(cfg['provider']);
      for (const providerName of Object.keys(provider)) {
        const prov = _obj(provider[providerName]);
        const opts = _obj(prov['options']);
        if (timeoutMs > 0) { opts['timeout'] = timeoutMs; } else { delete opts['timeout']; }
        if (chunkTimeoutMs > 0) { opts['chunkTimeout'] = chunkTimeoutMs; } else { delete opts['chunkTimeout']; }
        if (Object.keys(opts).length > 0) { prov['options'] = opts; }
        else if ('options' in prov && Object.keys(_obj(prov['options'])).length === 0) { delete prov['options']; }
        provider[providerName] = prov;
      }
      cfg['provider'] = provider;
    }, log, 'OpenCode timeout settings');
  }

  // -------------------------------------------------------------------------
  // MCP sync — project-local only (no global config modifications)
  // -------------------------------------------------------------------------

  /**
   * Write MCP server definitions to project-local config files only.
   * Covers: .claude/settings.local.json, .vscode/mcp.json, opencode.json, .mcp.json
   * The memory server uses <root>/.autodev/memories/.mcp-graph.json as its storage file.
   *
   * The full server set is `DEFAULT_MCP_SERVERS` ∪ user-defined entries from
   * `.autodev/settings.json:mcpServers`. User entries with the same name as
   * a default override the default — that lets users tune env vars / args of
   * the built-in servers (e.g. point `memory` at a different file).
   */
  static syncProjectMcpServers(root: string, log?: (m: string) => void): void {
    const baseServers: McpServerEntry[] = [
      ...DEFAULT_MCP_SERVERS,
      {
        name: 'memory',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: {
          MEMORY_FILE_PATH: '.autodev/memories/.mcp-graph.json',
        },
        tools: ['*'] as string[],
      },
    ];

    // One-time migration: if .autodev/settings.json still carries an
    // mcpServers block from before .mcp.json was the source of truth, copy
    // the user entries into .mcp.json and strip them from settings.
    let disabledBuiltins: string[] = [];
    try {
      const s = loadSettingsForRoot(root);
      disabledBuiltins = s.disabledBuiltinMcp ?? [];
      const stale = (s as unknown as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }> }).mcpServers;
      if (stale && Object.keys(stale).length > 0) {
        _migrateLegacyMcpServers(root, stale, log);
      }
    } catch { /* ignore */ }

    // User entries now live in .mcp.json — read them straight from there.
    let userMcp = loadProjectUserMcp(root);

    // Heal mis-tagged migrations: any entry whose name matches a default
    // server is a built-in, not a user entry — even if a previous migration
    // tagged it _meta.kind="user". Re-tagging here lets the built-in toggle
    // (disabledBuiltinMcp) actually take effect for these entries.
    const defaultNames = new Set(baseServers.map(s => s.name));
    const misTagged = Object.keys(userMcp).filter(n => defaultNames.has(n));
    if (misTagged.length > 0) {
      const cleaned: McpJsonEntries = {};
      for (const [name, e] of Object.entries(userMcp)) {
        if (defaultNames.has(name)) continue;
        cleaned[name] = e; // preserve as-is (stdio or remote); saveProjectUserMcp normalizes
      }
      try {
        saveProjectUserMcp(root, cleaned);
        log?.(`ConfigManager: re-tagged ${misTagged.length} mis-classified built-in entr${misTagged.length === 1 ? 'y' : 'ies'} (${misTagged.join(', ')})`);
        userMcp = loadProjectUserMcp(root);
      } catch (e) { log?.(`ConfigManager: failed re-tagging built-ins: ${e}`); }
    }

    const builtinByName = new Map<string, McpServerEntry>();
    for (const s of baseServers) {
      if (disabledBuiltins.includes(s.name)) continue;
      builtinByName.set(s.name, s);
    }
    // User entries override built-ins (so a user can re-tune a default).
    // Disabled entries (enabled:false) don't override — the builtin still syncs.
    for (const [userName, userEntry] of Object.entries(userMcp)) {
      if (userEntry.enabled === false) continue;
      builtinByName.delete(userName);
    }

    // Persist built-ins back to .mcp.json with _meta.kind="builtin" so the
    // sidebar can tell them apart from user entries on the next read.
    const builtinsForJson: McpJsonEntries = {};
    for (const [name, s] of builtinByName) {
      builtinsForJson[name] = { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) };
    }

    // Auto-attach the pixel-office A2A MCP server (remote/HTTP) when this agent
    // is bound to an office. Gives it agent-to-agent tools (list_agents,
    // send_message, check_messages) authenticated by its own api key. Users can
    // opt out via disabledBuiltinMcp: ["pixel-office"].
    try {
      const s = loadSettingsForRoot(root);
      const key = s.serverApiKey || '';
      // serverBaseUrl is derived from wsUrl (e.g. wss://host/ws), so take just the
      // origin and normalize ws/wss → http/https. The A2A MCP endpoint lives at
      // <origin>/api/mcp/a2a, not under the /ws path.
      let origin = '';
      try {
        const u = new URL(s.serverBaseUrl || '');
        const proto = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
        origin = `${proto}//${u.host}`;
      } catch { /* invalid/empty url */ }
      if (origin && key && !disabledBuiltins.includes('pixel-office')) {
        // MCP-only agents (no autodev loop) get the OPERATOR bridge — a local
        // stdio server (`autodev mcp-operate <root>`) that speaks to
        // …/api/office-mcp. Unlike the A2A remote it registers presence and
        // exposes the full agent toolkit (tasks/report/status) plus A2A, so a
        // pure-MCP client (opencode/Kimi, Claude Code, …) becomes a real,
        // online office agent instead of a messaging-only, offline one. The
        // bridge reads url+key from the workspace binding, so no token is
        // written into the provider config files. Loop agents keep the A2A
        // remote (they already have their own WS presence + task loop).
        builtinsForJson['pixel-office'] = s.mcpOnly
          ? { command: 'autodev', args: ['mcp-operate', root] }
          : {
              type: 'http',
              url: `${origin}/api/mcp/a2a`,
              headers: { Authorization: `Bearer ${key}` },
            };
      }
    } catch { /* ignore — office binding is optional */ }

    try { replaceProjectBuiltinMcp(root, builtinsForJson); }
    catch (e) { log?.(`ConfigManager: failed updating .mcp.json built-ins: ${e}`); }

    // Combined effective set fed to the other provider configs. Built-ins here
    // already include the remote 'pixel-office' entry; user entries can be stdio
    // OR remote. Disabled user entries (enabled:false) are kept in .mcp.json for
    // credential preservation but must NOT be propagated to other provider configs.
    const effective: McpJsonEntries = { ...builtinsForJson };
    for (const [name, raw] of Object.entries(userMcp)) {
      if (raw.enabled === false) continue;
      // Skip malformed entries (neither a stdio command nor a remote url) so we
      // never emit `command: undefined` / `[null]` into a provider config.
      if (!isRemoteMcp(raw) && typeof raw.command !== 'string') continue;
      effective[name] = raw;
    }

    // Names autodev may manage (everything in .mcp.json in any state + built-ins
    // + pixel-office). Used to PRUNE entries from provider configs when they're
    // disabled/removed — otherwise a merge-only write leaves stale entries (and
    // their bearer tokens) behind after an opt-out. Foreign entries autodev never
    // managed are left untouched.
    const managedNames = new Set<string>([
      ...Object.keys(effective),
      ...Object.keys(loadProjectAllMcp(root)),
      ...baseServers.map(s => s.name),
      'pixel-office',
    ]);

    // Strip any stale mcpServers we previously wrote into .claude/settings.json
    // or .claude/settings.local.json so they don't shadow .mcp.json.
    for (const stale of ['settings.json', 'settings.local.json']) {
      const p = path.join(root, '.claude', stale);
      if (!fs.existsSync(p)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
        if (cfg && typeof cfg.mcpServers === 'object' && cfg.mcpServers) {
          delete cfg.mcpServers;
          fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
          log?.(`ConfigManager: removed stale mcpServers from .claude/${stale}`);
        }
      } catch { /* ignore */ }
    }

    // VS Code workspace MCP: .vscode/mcp.json — supports remote { type, url, headers }.
    _mergeJson(path.join(root, '.vscode', 'mcp.json'), (cfg) => {
      const srv = _obj(cfg['servers']);
      for (const name of managedNames) {
        const e = effective[name];
        if (!e) { delete srv[name]; continue; }
        srv[name] = isRemoteMcp(e)
          ? { type: e.type === 'sse' ? 'sse' : 'http', url: e.url, ...(e.headers ? { headers: e.headers } : {}) }
          : { command: e.command, args: e.args ?? [], ...(e.env ? { env: e.env } : {}) };
      }
      cfg['servers'] = srv;
    }, log, 'VS Code MCP (.vscode/mcp.json)');

    // OpenCode project config: opencode.json — remote servers use type:'remote'.
    _mergeJson(path.join(root, 'opencode.json'), (cfg) => {
      const mcp = _obj(cfg['mcp']);
      for (const name of managedNames) {
        const e = effective[name];
        if (!e) { delete mcp[name]; continue; }
        if (isRemoteMcp(e)) {
          mcp[name] = { type: 'remote', url: e.url, enabled: true, ...(e.headers ? { headers: e.headers } : {}) };
        } else {
          const entry: Record<string, unknown> = { type: 'local', command: [e.command, ...(e.args ?? [])], enabled: true };
          if (e.env && Object.keys(e.env).length > 0) { entry['environment'] = e.env; }
          mcp[name] = entry;
        }
      }
      cfg['mcp'] = mcp;
    }, log, 'OpenCode project MCP (opencode.json)');

    // Copilot CLI MCP — PER-WORKSPACE, not the global ~/.copilot/mcp-config.json.
    //
    // Copilot's own config file is global, so on a box running several agents each
    // sync clobbered the last one: every copilot agent ended up pointing at
    // whichever workspace synced most recently — i.e. operating the WRONG office
    // character (its `pixel-office` entry carries that agent's bearer token). The
    // deployer runs many agents per box, so this was the normal case, not an edge.
    //
    // Copilot takes `--additional-mcp-config @<file>` (per session, augments the
    // global file), so write our servers to a file inside the WORKSPACE and let
    // the command builder pass it. Each agent then carries its own MCP config and
    // they stop fighting. See buildCopilotCliCommand().
    _writeJson(copilotMcpConfigPath(root), () => {
      const srv: Record<string, unknown> = {};
      for (const name of managedNames) {
        const e = effective[name];
        if (!e) { continue; }
        srv[name] = isRemoteMcp(e)
          ? { type: e.type === 'sse' ? 'sse' : 'http', url: e.url, ...(e.headers ? { headers: e.headers } : {}), tools: ['*'] }
          : { type: 'local', command: e.command, args: e.args ?? [], env: e.env ?? {}, tools: ['*'] };
      }
      return { mcpServers: srv };
    }, log, 'Copilot MCP (per-workspace)');

    // Belt and braces: strip the servers we used to write into the GLOBAL file, so
    // an agent upgrading from an older CLI doesn't keep a stale pixel-office entry
    // (with another agent's token) that `--additional-mcp-config` would augment.
    const globalCopilot = path.join(os.homedir(), '.copilot', 'mcp-config.json');
    if (fs.existsSync(globalCopilot)) {
      _mergeJson(globalCopilot, (cfg) => {
        const srv = _obj(cfg['mcpServers']);
        for (const name of managedNames) { delete srv[name]; }
        cfg['mcpServers'] = srv;
      }, log, 'Copilot MCP (pruned stale global entries)');
    }

    // Grok project config: ./.grok/config.toml — [mcp_servers.<name>] blocks.
    // Remote servers carry a nested [mcp_servers.<name>.headers] table for the
    // A2A bearer token. TOML (not JSON), so we regenerate only the managed
    // mcp_servers blocks and preserve any other grok settings in the file.
    _writeGrokToml(path.join(root, '.grok', 'config.toml'), managedNames, effective, log);
  }

  /**
   * Report the agent's effective MCP servers to pixel-office so the profile's
   * MCP tab can show what the agent actually has (built-ins + the pixel-office
   * A2A server + user entries). Sends names/kind/detail ONLY — never headers,
   * tokens, or env values. Best-effort and fire-and-forget.
   */
  static async reportProjectMcp(root: string, log?: (m: string) => void): Promise<void> {
    try {
      const s = loadSettingsForRoot(root);
      const key = s.serverApiKey || '';
      let origin = '';
      try {
        const u = new URL(s.serverBaseUrl || '');
        const proto = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
        origin = `${proto}//${u.host}`;
      } catch { /* not office-bound */ }
      if (! origin || ! key) { return; }

      const all = loadProjectAllMcp(root);
      const servers = Object.entries(all).map(([name, e]) => {
        const remote = isRemoteMcp(e);
        let detail = '';
        if (remote) { try { detail = new URL(e.url as string).host; } catch { detail = ''; } }
        else { detail = e.command ? [e.command, ...(e.args ?? [])].join(' ') : ''; }
        return {
          name,
          kind: remote ? 'remote' : 'stdio',
          detail,                                   // host (remote) or command line (stdio) — no secrets
          builtin: e._meta?.kind === 'builtin',
          enabled: e.enabled !== false,
        };
      });

      // Node 18+ global fetch. Best-effort — swallow any network/DNS error.
      const f = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
      if (! f) { return; }
      await f(`${origin}/api/agent-mcp-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ servers }),
      });
      log?.(`MCP: reported ${servers.length} servers to pixel-office`);
    } catch { /* best-effort */ }
  }

  /**
   * @deprecated Use syncProjectMcpServers(root) instead.
   * Kept for backwards compat — no longer called from applyAll.
   */
  static syncDefaultMcpServers(log?: (m: string) => void): void {
    McpServerManager.addDefaults(undefined, log);
  }

  // -------------------------------------------------------------------------
  // Master entry point — call once at extension activation
  // -------------------------------------------------------------------------

  static applyAll(root?: string, log?: (m: string) => void): void {
    try { ConfigManager.applyClaudePermissions(root, log); }
    catch (err) { log?.(`ConfigManager: Claude permissions error: ${err}`); }

    try { ConfigManager.applyOpenCodePermissions(root, log); }
    catch (err) { log?.(`ConfigManager: OpenCode permissions error: ${err}`); }

    // Project-local MCP sync — no global config files are modified
    if (root) {
      try { ConfigManager.syncProjectMcpServers(root, log); }
      catch (err) { log?.(`ConfigManager: Project MCP sync error: ${err}`); }
      // Report the effective server set to pixel-office so the UI can show it.
      void ConfigManager.reportProjectMcp(root, log);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _obj(val: unknown): Record<string, unknown> {
  return (typeof val === 'object' && val !== null ? val : {}) as Record<string, unknown>;
}

/**
 * Move any user-defined `mcpServers` block from .autodev/settings.json into
 * .mcp.json (one-time, idempotent — once stripped from settings it doesn't run
 * again). Existing user entries already in .mcp.json take precedence.
 */
function _migrateLegacyMcpServers(
  root: string,
  legacy: Record<string, { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>,
  log: ((m: string) => void) | undefined,
): void {
  try {
    const existing = loadProjectUserMcp(root);
    const merged: McpJsonEntries = { ...existing };
    let migratedCount = 0;
    const defaultNames = new Set(DEFAULT_MCP_SERVERS.map(s => s.name).concat('memory'));
    for (const [name, raw] of Object.entries(legacy)) {
      if (!raw || typeof raw.command !== 'string') continue;
      if (raw.enabled === false) continue; // disabled = drop, per the new model
      if (defaultNames.has(name)) continue; // built-in — never a user entry
      if (existing[name]) continue;         // .mcp.json wins
      merged[name] = { command: raw.command, args: raw.args, ...(raw.env ? { env: raw.env } : {}) };
      migratedCount += 1;
    }
    if (migratedCount > 0) {
      saveProjectUserMcp(root, merged);
      log?.(`ConfigManager: migrated ${migratedCount} mcpServers entr${migratedCount === 1 ? 'y' : 'ies'} from .autodev/settings.json → .mcp.json`);
    }
  } catch (e) { log?.(`ConfigManager: legacy MCP migration failed: ${e}`); }

  // Strip the field from settings.json regardless — the file is no longer the source.
  try {
    const settingsFile = path.join(root, '.autodev', 'settings.json');
    if (!fs.existsSync(settingsFile)) return;
    const cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    if (cfg && 'mcpServers' in cfg) {
      delete (cfg as Record<string, unknown>)['mcpServers'];
      fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2), 'utf8');
      log?.('ConfigManager: stripped legacy mcpServers from .autodev/settings.json');
    }
  } catch { /* ignore */ }
}

/**
 * Read a JSON file, apply a mutation, and write it back.
 * Creates missing parent directories automatically.
 */
function _mergeJson(
  filePath: string,
  mutate: (cfg: Record<string, unknown>) => void,
  log: ((m: string) => void) | undefined,
  label: string,
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try { cfg = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { }
    }
    mutate(cfg);
    fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    log?.(`ConfigManager: applied ${label}`);
  } catch (err) {
    log?.(`ConfigManager: failed ${label}: ${err}`);
  }
}

/**
 * Write a file we fully own (unlike _mergeJson, which preserves foreign keys).
 * Used for the per-workspace copilot MCP config: it is generated wholesale from
 * the effective server set, so a removed/disabled server must actually vanish
 * rather than linger from a previous write.
 */
function _writeJson(
  filePath: string,
  build: () => unknown,
  log: ((m: string) => void) | undefined,
  label: string,
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(filePath, JSON.stringify(build(), null, 2) + '\n', 'utf8');
    log?.(`ConfigManager: applied ${label}`);
  } catch (err) {
    log?.(`ConfigManager: failed ${label}: ${err}`);
  }
}

/** Escape a string as a TOML basic (double-quoted) value. */
function _tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

/** A TOML key — bare if it's a simple identifier, otherwise quoted. */
function _tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : _tomlStr(name);
}

/**
 * Write ./.grok/config.toml MCP servers. grok uses `[mcp_servers.<name>]`
 * tables (remote servers carry a nested `[mcp_servers.<name>.headers]` table
 * for the A2A bearer token). Since this is TOML — not JSON — we regenerate only
 * the autodev-managed `[mcp_servers.*]` tables and preserve any other grok
 * settings in the file verbatim.
 */
function _writeGrokToml(
  filePath: string,
  managedNames: Set<string>,
  effective: McpJsonEntries,
  log?: (m: string) => void,
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

    // Read existing file and drop every [mcp_servers...] table (autodev owns
    // those); keep all other tables/keys untouched.
    let preserved = '';
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      const kept: string[] = [];
      let skipping = false;
      for (const line of lines) {
        const m = /^\s*\[\s*([^\]]*?)\s*\]/.exec(line);
        if (m) { skipping = /^mcp_servers\b/.test(m[1]); }
        if (!skipping) { kept.push(line); }
      }
      preserved = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // Regenerate the managed [mcp_servers.<name>] tables from the effective set.
    // A pruned/disabled entry simply isn't emitted (regeneration drops it).
    const blocks: string[] = [];
    for (const name of managedNames) {
      const e = effective[name];
      if (!e) continue;
      const key = `mcp_servers.${_tomlKey(name)}`;
      if (isRemoteMcp(e) && e.url) {
        const b = [`[${key}]`, `url = ${_tomlStr(e.url)}`, `enabled = true`];
        if (e.headers && Object.keys(e.headers).length) {
          b.push('', `[${key}.headers]`);
          for (const [hk, hv] of Object.entries(e.headers)) { b.push(`${_tomlKey(hk)} = ${_tomlStr(String(hv))}`); }
        }
        blocks.push(b.join('\n'));
      } else if (typeof e.command === 'string') {
        const b = [`[${key}]`, `command = ${_tomlStr(e.command)}`,
          `args = [${(e.args ?? []).map(a => _tomlStr(String(a))).join(', ')}]`, `enabled = true`];
        if (e.env && Object.keys(e.env).length) {
          b.push('', `[${key}.env]`);
          for (const [ek, ev] of Object.entries(e.env)) { b.push(`${_tomlKey(ek)} = ${_tomlStr(String(ev))}`); }
        }
        blocks.push(b.join('\n'));
      }
    }

    const out = [preserved, blocks.join('\n\n')].filter(Boolean).join('\n\n').trim() + '\n';
    fs.writeFileSync(filePath, out, 'utf8');
    log?.('ConfigManager: applied Grok project MCP (.grok/config.toml)');
  } catch (err) {
    log?.(`ConfigManager: failed Grok project MCP (.grok/config.toml): ${err}`);
  }
}
