import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// projectMcp — read/write user MCP entries to <root>/.mcp.json directly.
//
// `.mcp.json` is the official, Anthropic-blessed location for project MCP
// servers (see https://code.claude.com/docs/en/mcp). We treat it as the single
// source of truth for user-defined MCP entries — the extension never stores
// `mcpServers` in `.autodev/settings.json` anymore.
//
// To distinguish user-managed from autodev-managed (built-in) entries we tag
// them with `_meta.kind`:
//   - "user"    — added through the sidebar form; survives user edits
//   - "builtin" — pushed by ConfigManager.syncProjectMcpServers (defaults)
// Untagged entries are treated as user entries (they pre-existed in .mcp.json
// before this refactor).
// ---------------------------------------------------------------------------

export interface McpJsonEntry {
  /** stdio servers: the executable. Remote (http/sse) servers omit this and set `url`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote MCP transport. Present for HTTP/SSE servers (e.g. the pixel-office A2A server). */
  type?: 'stdio' | 'http' | 'sse';
  /** Remote MCP endpoint URL (when type is http/sse). */
  url?: string;
  /** Headers sent to the remote MCP endpoint (e.g. Authorization: Bearer <token>). */
  headers?: Record<string, string>;
  /** false = entry is kept in .mcp.json to preserve credentials but not synced to providers */
  enabled?: boolean;
  alwaysLoad?: boolean;
  _meta?: { managedBy?: string; name?: string; kind?: 'user' | 'builtin'; [k: string]: unknown };
}

/** True for remote (http/sse) MCP entries — identified by a url instead of a command. */
export function isRemoteMcp(e: McpJsonEntry): boolean {
  return typeof e?.url === 'string' && e.url.length > 0;
}

export type McpJsonEntries = Record<string, McpJsonEntry>;

const MCP_FILE = '.mcp.json';

function _file(root: string): string { return path.join(root, MCP_FILE); }

function _readAll(root: string): McpJsonEntries {
  try {
    const f = _file(root);
    if (!fs.existsSync(f)) return {};
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
    const mcp = cfg && typeof cfg.mcpServers === 'object' && cfg.mcpServers ? cfg.mcpServers as McpJsonEntries : {};
    return mcp || {};
  } catch { return {}; }
}

function _writeAll(root: string, entries: McpJsonEntries): void {
  const f = _file(root);
  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(f)) {
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>; } catch { /* overwrite */ }
  }
  cfg.mcpServers = entries;
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function _isBuiltin(entry: McpJsonEntry): boolean {
  return entry?._meta?.kind === 'builtin';
}

/** Canonicalize an entry to either the remote (type/url/headers) or stdio (command/args/env) shape. */
function _normalizeMcp(raw: McpJsonEntry): McpJsonEntry {
  if (isRemoteMcp(raw)) {
    return {
      type: raw.type ?? 'http',
      url: raw.url as string,
      ...(raw.headers && typeof raw.headers === 'object' ? { headers: raw.headers } : {}),
    };
  }
  return {
    command: raw.command as string,
    args: Array.isArray(raw.args) ? raw.args : [],
    ...(raw.env && typeof raw.env === 'object' ? { env: raw.env } : {}),
  };
}

/** Return only USER entries from .mcp.json (built-ins filtered out). */
export function loadProjectUserMcp(root: string): McpJsonEntries {
  const all = _readAll(root);
  const out: McpJsonEntries = {};
  for (const [name, e] of Object.entries(all)) {
    if (!_isBuiltin(e)) out[name] = e;
  }
  return out;
}

/** Read every entry from .mcp.json (user + builtin). */
export function loadProjectAllMcp(root: string): McpJsonEntries {
  return _readAll(root);
}

/** Write the full set of user entries (full replace), preserving any built-ins. */
export function saveProjectUserMcp(root: string, userEntries: McpJsonEntries): void {
  const all = _readAll(root);
  for (const [name, e] of Object.entries(all)) {
    if (!_isBuiltin(e)) delete all[name];
  }
  for (const [name, raw] of Object.entries(userEntries)) {
    if (!raw || (typeof raw.command !== 'string' && !isRemoteMcp(raw))) continue;
    const meta = { ...(raw._meta || {}), managedBy: 'autoaidev', name, kind: 'user' as const };
    all[name] = {
      ..._normalizeMcp(raw),
      alwaysLoad: true,
      // Preserve disabled state so credentials survive unchecking in the sidebar.
      ...(raw.enabled === false ? { enabled: false } : {}),
      _meta: meta,
    };
  }
  _writeAll(root, all);
}

/** Remove a single user entry by name. Built-ins are not touched. */
export function removeProjectUserMcp(root: string, name: string): boolean {
  const all = _readAll(root);
  const e = all[name];
  if (!e || _isBuiltin(e)) return false;
  delete all[name];
  _writeAll(root, all);
  return true;
}

/** Replace every built-in entry with the supplied set, leaving user entries alone. */
export function replaceProjectBuiltinMcp(root: string, builtins: McpJsonEntries): void {
  const all = _readAll(root);
  for (const [name, e] of Object.entries(all)) {
    if (_isBuiltin(e)) delete all[name];
  }
  for (const [name, raw] of Object.entries(builtins)) {
    if (!raw || (typeof raw.command !== 'string' && !isRemoteMcp(raw))) continue;
    const meta = { ...(raw._meta || {}), managedBy: 'autoaidev', name, kind: 'builtin' as const };
    all[name] = {
      ..._normalizeMcp(raw),
      alwaysLoad: true,
      _meta: meta,
    };
  }
  _writeAll(root, all);
}
