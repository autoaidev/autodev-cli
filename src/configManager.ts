import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerManager, DEFAULT_MCP_SERVERS, McpServerEntry } from './mcpManager';
import { loadSettingsForRoot } from './core/settingsLoader';
import { loadProjectUserMcp, saveProjectUserMcp, replaceProjectBuiltinMcp, isRemoteMcp, type McpJsonEntry, type McpJsonEntries } from './core/projectMcp';

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
      // origin and normalize ws/wss → http/https. The MCP endpoint lives at
      // <origin>/api/mcp, not under the /ws path.
      let origin = '';
      try {
        const u = new URL(s.serverBaseUrl || '');
        const proto = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
        origin = `${proto}//${u.host}`;
      } catch { /* invalid/empty url */ }
      if (origin && key && !disabledBuiltins.includes('pixel-office')) {
        builtinsForJson['pixel-office'] = {
          type: 'http',
          url: `${origin}/api/mcp`,
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
      effective[name] = raw;
    }
    const effectiveList: Array<[string, McpJsonEntry]> = Object.entries(effective);

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
      for (const [name, e] of effectiveList) {
        srv[name] = isRemoteMcp(e)
          ? { type: e.type === 'sse' ? 'sse' : 'http', url: e.url, ...(e.headers ? { headers: e.headers } : {}) }
          : { command: e.command, args: e.args ?? [], ...(e.env ? { env: e.env } : {}) };
      }
      cfg['servers'] = srv;
    }, log, 'VS Code MCP (.vscode/mcp.json)');

    // OpenCode project config: opencode.json — remote servers use type:'remote'.
    _mergeJson(path.join(root, 'opencode.json'), (cfg) => {
      const mcp = _obj(cfg['mcp']);
      for (const [name, e] of effectiveList) {
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

    // Copilot CLI config: ~/.copilot/mcp-config.json — supports remote { type:'http', url, headers }.
    // NOTE: Copilot's MCP config is GLOBAL (not per-workspace), so on a box running
    // multiple agents the pixel-office token is the last-synced agent's. Fine for
    // single-agent boxes; opt out with disabledBuiltinMcp:['pixel-office'].
    _mergeJson(path.join(os.homedir(), '.copilot', 'mcp-config.json'), (cfg) => {
      const srv = _obj(cfg['mcpServers']);
      for (const [name, e] of effectiveList) {
        srv[name] = isRemoteMcp(e)
          ? { type: e.type === 'sse' ? 'sse' : 'http', url: e.url, ...(e.headers ? { headers: e.headers } : {}), tools: ['*'] }
          : { type: 'local', command: e.command, args: e.args ?? [], env: e.env ?? {}, tools: ['*'] };
      }
      cfg['mcpServers'] = srv;
    }, log, 'Copilot MCP (~/.copilot/mcp-config.json)');
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
