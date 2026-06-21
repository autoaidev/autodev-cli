import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// McpServerManager — unified MCP server configuration across all CLI providers
//
// Each provider stores MCP server definitions in its own config file with a
// slightly different schema.  This class normalises them into a single
// McpServerEntry type and provides add / remove / list / syncAll operations
// that write to every provider at once.
//
// Config file locations:
//   Claude CLI  : ~/.claude/settings.json      (key: mcpServers)
//   Copilot CLI : ~/.copilot/mcp-config.json   (key: mcpServers, has "type"/"tools")
//   OpenCode CLI: %APPDATA%/opencode/config.json (key: mcp, command is an array)
// ---------------------------------------------------------------------------

/**
 * Default MCP servers applied to every CLI provider on extension activation.
 * Add entries here to have them automatically synced to Claude, Copilot, and OpenCode.
 */
export const DEFAULT_MCP_SERVERS: McpServerEntry[] = [
  {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {
      MEMORY_FILE_PATH: '.autodev/memories/.mcp-graph.json',
    },
    tools: ['*'],
  },
  {
    name: 'playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    tools: ['*'],
  },
  {
    name: 'sequential-thinking',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tools: ['*'],
  },
  {
    name: 'computer-use-mcp',
    command: 'npx',
    args: ['-y', 'computer-use-mcp'],
    tools: ['*'],
  },
];

/** Canonical representation of a single MCP server. */
export interface McpServerEntry {
  /** Unique server name (used as the key in every provider config). */
  name: string;
  /** Executable to run (e.g. "npx", "node", "python"). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Optional environment variables to inject. */
  env?: Record<string, string>;
  /**
   * Copilot-specific tool filter — defaults to ["*"] (all tools allowed).
   * Ignored for Claude and OpenCode.
   */
  tools?: string[];
}

// ---------------------------------------------------------------------------
// Internal schema types per provider
// ---------------------------------------------------------------------------

interface ClaudeServerSchema {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeConfigSchema {
  mcpServers?: Record<string, ClaudeServerSchema>;
  [key: string]: unknown;
}

interface CopilotServerSchema {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
}

interface CopilotConfigSchema {
  mcpServers?: Record<string, CopilotServerSchema>;
  [key: string]: unknown;
}

interface OpenCodeServerSchema {
  type?: string;
  /** OpenCode stores command + args as a single array: [command, ...args] */
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
}

interface OpenCodeConfigSchema {
  mcp?: Record<string, OpenCodeServerSchema>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function claudeConfigPath(): string {
  // Claude CLI reads mcpServers from ~/.claude/settings.json
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** ~/.claude.json — stores per-project enabledMcpjsonServers */
function claudeDotJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

interface ClaudeDotJson {
  projects?: Record<string, { enabledMcpjsonServers?: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ClaudeProjectSettings {
  attribution?: { commit?: string; pr?: string };
  includeCoAuthoredBy?: boolean;
  [key: string]: unknown;
}

function copilotConfigPath(): string {
  return path.join(os.homedir(), '.copilot', 'mcp-config.json');
}

function opencodeConfigPath(): string {
  // Windows: %APPDATA%\opencode\config.json
  // Linux/macOS: ~/.config/opencode/config.json
  const base =
    process.platform === 'win32'
      ? (process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode', 'config.json');
}

// ---------------------------------------------------------------------------
// Generic JSON read / write helpers
// ---------------------------------------------------------------------------

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }
  } catch { /* treat missing / corrupt file as empty */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Per-provider read / write
// ---------------------------------------------------------------------------

function readClaudeServers(): Record<string, McpServerEntry> {
  const cfg = readJson<ClaudeConfigSchema>(claudeConfigPath(), {});
  const result: Record<string, McpServerEntry> = {};
  for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {
    result[name] = {
      name,
      command: s.command,
      args: s.args ?? [],
      ...(s.env ? { env: s.env } : {}),
    };
  }
  return result;
}

function writeClaudeServers(servers: Record<string, McpServerEntry>): void {
  const cfg = readJson<ClaudeConfigSchema>(claudeConfigPath(), {});
  cfg.mcpServers = {};
  for (const [name, s] of Object.entries(servers)) {
    cfg.mcpServers[name] = {
      command: s.command,
      args: s.args,
      ...(s.env ? { env: s.env } : {}),
    };
  }
  writeJson(claudeConfigPath(), cfg);
}

function readCopilotServers(): Record<string, McpServerEntry> {
  const cfg = readJson<CopilotConfigSchema>(copilotConfigPath(), {});
  const result: Record<string, McpServerEntry> = {};
  for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {
    result[name] = {
      name,
      command: s.command,
      args: s.args ?? [],
      ...(s.env ? { env: s.env } : {}),
      tools: s.tools ?? ['*'],
    };
  }
  return result;
}

function writeCopilotServers(servers: Record<string, McpServerEntry>): void {
  const cfg = readJson<CopilotConfigSchema>(copilotConfigPath(), {});
  cfg.mcpServers = {};
  for (const [name, s] of Object.entries(servers)) {
    cfg.mcpServers[name] = {
      type: 'local',
      command: s.command,
      args: s.args,
      env: s.env ?? {},
      tools: s.tools ?? ['*'],
    };
  }
  writeJson(copilotConfigPath(), cfg);
}

function readOpenCodeServers(): Record<string, McpServerEntry> {
  const cfg = readJson<OpenCodeConfigSchema>(opencodeConfigPath(), {});
  const result: Record<string, McpServerEntry> = {};
  for (const [name, s] of Object.entries(cfg.mcp ?? {})) {
    const [command, ...args] = s.command;
    result[name] = {
      name,
      command: command ?? '',
      args,
      ...(s.environment ? { env: s.environment } : (s as unknown as Record<string,unknown>)['env'] ? { env: (s as unknown as Record<string,unknown>)['env'] as Record<string,string> } : {}),
    };
  }
  return result;
}

function writeOpenCodeServers(servers: Record<string, McpServerEntry>): void {
  const cfg = readJson<OpenCodeConfigSchema>(opencodeConfigPath(), {});
  cfg.mcp = {};
  for (const [name, s] of Object.entries(servers)) {
    const entry: OpenCodeServerSchema = {
      type: 'local',
      command: [s.command, ...s.args],
      enabled: true,
    };
    if (s.env && Object.keys(s.env).length > 0) {
      entry.environment = s.env;
    }
    cfg.mcp[name] = entry;
  }
  // Remove any legacy top-level keys that opencode no longer accepts
  // (e.g. "env" was renamed to "environment" in the mcp server schema).
  for (const server of Object.values(cfg.mcp)) {
    const s = server as unknown as Record<string, unknown>;
    delete s['env'];
  }
  writeJson(opencodeConfigPath(), cfg);
}

// ---------------------------------------------------------------------------
// McpServerManager — public API
// ---------------------------------------------------------------------------

export type McpProvider = 'claude-cli' | 'copilot-cli' | 'opencode-cli';

const ALL_PROVIDERS: McpProvider[] = ['claude-cli', 'copilot-cli', 'opencode-cli'];

export class McpServerManager {
  // -------------------------------------------------------------------------
  // Path accessors (static, for display/info purposes)
  // -------------------------------------------------------------------------

  static configPathFor(provider: McpProvider): string {
    if (provider === 'claude-cli')    { return claudeConfigPath(); }
    if (provider === 'copilot-cli')   { return copilotConfigPath(); }
    /* opencode-cli */                  return opencodeConfigPath();
  }

  // -------------------------------------------------------------------------
  // Per-provider read
  // -------------------------------------------------------------------------

  static readServers(provider: McpProvider): Record<string, McpServerEntry> {
    if (provider === 'claude-cli')    { return readClaudeServers(); }
    if (provider === 'copilot-cli')   { return readCopilotServers(); }
    /* opencode-cli */                  return readOpenCodeServers();
  }

  // -------------------------------------------------------------------------
  // Per-provider write (replaces all servers for that provider)
  // -------------------------------------------------------------------------

  static writeServers(provider: McpProvider, servers: Record<string, McpServerEntry>): void {
    if (provider === 'claude-cli')    { writeClaudeServers(servers); return; }
    if (provider === 'copilot-cli')   { writeCopilotServers(servers); return; }
    /* opencode-cli */                  writeOpenCodeServers(servers);
  }

  // -------------------------------------------------------------------------
  // Unified list — union of servers across all providers
  // -------------------------------------------------------------------------

  static listAll(): McpServerEntry[] {
    const merged: Record<string, McpServerEntry> = {};
    for (const provider of ALL_PROVIDERS) {
      for (const [name, entry] of Object.entries(McpServerManager.readServers(provider))) {
        if (!merged[name]) { merged[name] = entry; }
      }
    }
    return Object.values(merged);
  }

  // -------------------------------------------------------------------------
  // Add a server to all providers (or a specific subset)
  // -------------------------------------------------------------------------

  static addServer(
    entry: McpServerEntry,
    targets: McpProvider[] = ALL_PROVIDERS,
  ): void {
    for (const provider of targets) {
      const servers = McpServerManager.readServers(provider);
      servers[entry.name] = entry;
      McpServerManager.writeServers(provider, servers);
    }
  }

  // -------------------------------------------------------------------------
  // Remove a server from all providers (or a specific subset)
  // -------------------------------------------------------------------------

  static removeServer(
    name: string,
    targets: McpProvider[] = ALL_PROVIDERS,
  ): void {
    for (const provider of targets) {
      const servers = McpServerManager.readServers(provider);
      if (name in servers) {
        delete servers[name];
        McpServerManager.writeServers(provider, servers);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sync a full list of servers to all providers (replaces existing entries)
  // -------------------------------------------------------------------------

  static syncAll(
    servers: McpServerEntry[],
    targets: McpProvider[] = ALL_PROVIDERS,
  ): void {
    const map: Record<string, McpServerEntry> = {};
    for (const s of servers) { map[s.name] = s; }
    for (const provider of targets) {
      McpServerManager.writeServers(provider, map);
    }
  }

  // -------------------------------------------------------------------------
  // Add defaults — only inserts entries that aren't already present
  // -------------------------------------------------------------------------

  static addDefaults(
    targets: McpProvider[] = ALL_PROVIDERS,
    log?: (msg: string) => void,
  ): void {
    for (const server of DEFAULT_MCP_SERVERS) {
      for (const provider of targets) {
        const current = McpServerManager.readServers(provider);
        if (!current[server.name]) {
          current[server.name] = server;
          McpServerManager.writeServers(provider, current);
          log?.(`MCP: added '${server.name}' to ${provider}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // enableForClaudeProject — writes enabledMcpjsonServers into ~/.claude.json
  // under projects[workspaceRoot] so Claude Code actually loads them.
  // See: https://github.com/anthropics/claude-code/issues/24657
  // -------------------------------------------------------------------------

  static enableForClaudeProject(
    workspaceRoot: string,
    serverNames: string[],
    log?: (msg: string) => void,
  ): void {
    const dotJson = readJson<ClaudeDotJson>(claudeDotJsonPath(), {});
    dotJson.projects ??= {};
    const proj = dotJson.projects[workspaceRoot] ?? {};
    const existing = new Set(proj.enabledMcpjsonServers ?? []);
    const added: string[] = [];
    for (const name of serverNames) {
      if (!existing.has(name)) {
        existing.add(name);
        added.push(name);
      }
    }
    if (added.length === 0) { return; }
    proj.enabledMcpjsonServers = [...existing];
    dotJson.projects[workspaceRoot] = proj;
    writeJson(claudeDotJsonPath(), dotJson);
    log?.(`MCP: enabled [${added.join(', ')}] for Claude project ${workspaceRoot}`);
  }

  // -------------------------------------------------------------------------
  // disableAttribution — removes "Co-Authored-By" / "Generated with Claude Code"
  // footers by writing attribution settings to .claude/settings.json in the
  // project root.
  // -------------------------------------------------------------------------

  static disableAttribution(
    workspaceRoot: string,
    log?: (msg: string) => void,
  ): void {
    const settingsPath = path.join(workspaceRoot, '.claude', 'settings.json');
    const cfg = readJson<ClaudeProjectSettings>(settingsPath, {});
    cfg.attribution = { commit: '', pr: '' };
    cfg.includeCoAuthoredBy = false;
    writeJson(settingsPath, cfg);
    log?.(`MCP: wrote attribution=off to ${settingsPath}`);
  }

  // -------------------------------------------------------------------------
  // addDefaultsAndEnable — addDefaults + enableForClaudeProject in one call
  // -------------------------------------------------------------------------

  static addDefaultsAndEnable(
    workspaceRoot: string,
    targets: McpProvider[] = ALL_PROVIDERS,
    log?: (msg: string) => void,
  ): void {
    McpServerManager.addDefaults(targets, log);
    if (targets.includes('claude-cli')) {
      McpServerManager.enableForClaudeProject(
        workspaceRoot,
        DEFAULT_MCP_SERVERS.map(s => s.name),
        log,
      );
    }
  }
}
