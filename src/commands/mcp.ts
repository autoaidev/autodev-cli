import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import {
  loadProjectAllMcp, loadProjectUserMcp, saveProjectUserMcp, removeProjectUserMcp,
  isRemoteMcp, type McpJsonEntry,
} from '../core/projectMcp';
import { ConfigManager } from '../configManager';
import { DEFAULT_MCP_SERVERS } from '../mcpManager';
import { detectApp, detectBinOnPath, type BinDetectDeps, type DetectAppResult } from '../core/binDetect';
import {
  getCatalog, serverSpecFor, catalogEntry, GIMP_CLIENT_PLACEHOLDER,
  type CreativeAppId,
} from '../core/mcpCatalog';
import {
  loadSettingsForRoot, settingsWritePath, type AutodevSettings,
} from '../core/settingsLoader';
import { writeFileSecure } from '../core/secureFile';

// Names autodev treats as built-in MCP servers (toggled via disabledBuiltinMcp,
// not via an enabled:false entry in .mcp.json).
const BUILTIN_NAMES = new Set<string>([
  ...DEFAULT_MCP_SERVERS.map((s) => s.name), 'memory', 'pixel-office',
]);

function resolveRoot(p?: string): string {
  return p ? path.resolve(p) : process.cwd();
}

/** Commander collector for repeatable single-value options (append into an array). */
function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

function sync(root: string): void {
  ConfigManager.syncProjectMcpServers(root, (m) => log.gray(m));
}

function saveSettings(root: string, settings: AutodevSettings): void {
  const file = settingsWritePath(root);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  writeFileSecure(file, JSON.stringify(settings, null, 2) + '\n');
}

/** Parse repeated K=V option values into an object (ignores malformed pairs). */
function parseKvPairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) { return undefined; }
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) { log.warn(`Ignoring malformed pair "${p}" (expected KEY=VALUE)`); continue; }
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return Object.keys(out).length ? out : undefined;
}

function isBuiltinName(root: string, name: string): boolean {
  if (BUILTIN_NAMES.has(name)) { return true; }
  const all = loadProjectAllMcp(root);
  return all[name]?._meta?.kind === 'builtin';
}

function transportOf(e: McpJsonEntry): string {
  if (isRemoteMcp(e)) { return e.type === 'sse' ? 'sse' : 'http'; }
  return 'stdio';
}

// ---------------------------------------------------------------------------
// buildDetect — the stable JSON payload the app + extension consume. Pure &
// dependency-injectable (mirrors models.ts:buildModelCatalog).
// ---------------------------------------------------------------------------

export interface DetectPrereq {
  id: string;
  installed: boolean;
  installHint: string;
}

export interface DetectApp {
  id: CreativeAppId;
  name: string;
  installed: boolean;
  path: string | null;
  source: string | null;
  experimental: boolean;
  server: McpJsonEntry;
  serverName: string;
  prerequisites: DetectPrereq[];
  postSetup: string[];
  notes: string[];
  alreadyEnabled: boolean;
}

export interface DetectResult {
  apps: DetectApp[];
}

/** Is a prerequisite launcher present on PATH? (uvx / python[3]). */
function prereqInstalled(id: string, deps?: Partial<BinDetectDeps>): boolean {
  if (id === 'python') {
    return !!(detectBinOnPath('python3', deps) || detectBinOnPath('python', deps));
  }
  return !!detectBinOnPath(id, deps);
}

export function buildDetect(root: string, deps?: Partial<BinDetectDeps>): DetectResult {
  const platform = deps?.platform ?? process.platform;
  const existing = loadProjectAllMcp(root);
  const apps: DetectApp[] = getCatalog(platform).map((entry) => {
    const det: DetectAppResult = detectApp(entry.id, deps);
    const server = serverSpecFor(entry.id, platform);
    const prerequisites: DetectPrereq[] = entry.prerequisites.map((pr) => ({
      id: pr.id,
      installed: prereqInstalled(pr.id, deps),
      installHint: pr.installHint,
    }));
    return {
      id: entry.id,
      name: entry.name,
      installed: det.installed,
      path: det.path,
      source: det.source,
      experimental: entry.experimental,
      server,
      serverName: entry.serverName,
      prerequisites,
      postSetup: entry.postSetup,
      notes: entry.notes,
      alreadyEnabled: !!existing[entry.serverName],
    };
  });
  return { apps };
}

// ---------------------------------------------------------------------------
// buildCatalog — the single, stable "known/pickable MCP servers" catalog the
// app + extension render a "browse & add a known server" picker from (mirroring
// how `autodev models --json` backs the model picker). ONE authoritative source:
//   - 'builtin'  : sourced from DEFAULT_MCP_SERVERS (the always-applied baseline,
//                  toggled via disabledBuiltinMcp) — NOT re-hardcoded here.
//   - 'common'   : well-known, opt-in servers we have a REAL config for.
//   - 'creative' : blender / gimp from mcpCatalog (platform-aware via serverSpecFor).
// Keep this shape stable — external consumers depend on it.
// ---------------------------------------------------------------------------

export type CatalogKind = 'builtin' | 'common' | 'creative';

/** The concrete server config a picker would write (stdio or remote McpJsonEntry). */
export interface CatalogEntry {
  id: string;
  name: string;
  kind: CatalogKind;
  transport: 'stdio' | 'http' | 'sse';
  server: McpJsonEntry;
  description: string;
  experimental: boolean;
  /** Present for 'creative' entries — the host app this server drives. */
  requiresApp?: CreativeAppId;
}

export interface CatalogResult {
  servers: CatalogEntry[];
}

// Human-facing metadata for the built-ins (name + one-line description). The
// server CONFIG (command/args/env) is always taken from DEFAULT_MCP_SERVERS —
// only the display strings live here.
const BUILTIN_META: Record<string, { name: string; description: string }> = {
  'memory': { name: 'Memory', description: 'Persistent knowledge-graph memory across sessions' },
  'playwright': { name: 'Playwright', description: 'Browser automation & web interaction' },
  'sequential-thinking': { name: 'Sequential Thinking', description: 'Structured step-by-step reasoning scratchpad' },
  'computer-use-mcp': { name: 'Computer Use', description: 'Desktop control: screenshot, mouse & keyboard' },
};

/** Placeholder allowed-dir the filesystem 'common' entry carries until the user edits it. */
export const FILESYSTEM_PATH_PLACEHOLDER = '<ALLOWED_DIR>';

/** Convert an mcpManager McpServerEntry → the catalog stdio server shape (drops copilot `tools`). */
function builtinServer(command: string, args: string[], env?: Record<string, string>): McpJsonEntry {
  return { command, args, ...(env && Object.keys(env).length ? { env } : {}) };
}

/** Human-facing metadata for the 'creative' entries (description keyed by app id). */
const CREATIVE_DESCRIPTION: Record<CreativeAppId, string> = {
  blender: '3D modeling & scene control via the Blender MCP addon',
  gimp: 'Image editing via the GIMP MCP bridge (experimental)',
};

/**
 * Build the authoritative catalog of known/pickable MCP servers. Pure &
 * platform-parameterised (defaults to process.platform) so the app consumes it
 * via `mcp catalog --json` and the extension imports it in-process.
 */
export function buildCatalog(platform: NodeJS.Platform = process.platform): CatalogResult {
  const servers: CatalogEntry[] = [];

  // 1) built-ins — sourced from DEFAULT_MCP_SERVERS (never re-hardcoded).
  for (const s of DEFAULT_MCP_SERVERS) {
    const meta = BUILTIN_META[s.name];
    servers.push({
      id: s.name,
      name: meta?.name ?? s.name,
      kind: 'builtin',
      transport: 'stdio',
      server: builtinServer(s.command, s.args, s.env),
      description: meta?.description ?? '',
      experimental: false,
    });
  }

  // 2) common — well-known, opt-in servers we have a REAL config for. We only
  // ship 'filesystem' (the real @modelcontextprotocol/server-filesystem) with a
  // placeholder scoped-dir the user edits. No invented github/fetch entries.
  servers.push({
    id: 'filesystem',
    name: 'Filesystem',
    kind: 'common',
    transport: 'stdio',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', FILESYSTEM_PATH_PLACEHOLDER],
    },
    description: 'Local filesystem access (scoped to an allowed directory)',
    experimental: false,
  });

  // 3) creative — blender / gimp from mcpCatalog, platform-aware via serverSpecFor.
  for (const entry of getCatalog(platform)) {
    servers.push({
      id: entry.id,
      name: entry.name,
      kind: 'creative',
      transport: 'stdio',
      server: serverSpecFor(entry.id, platform),
      description: CREATIVE_DESCRIPTION[entry.id],
      experimental: entry.experimental,
      requiresApp: entry.id,
    });
  }

  return { servers };
}

// ---------------------------------------------------------------------------
// --enable <app> — write the server spec + propagate + print manual steps.
// ---------------------------------------------------------------------------

function enableApp(root: string, app: CreativeAppId, opts: { gimpClient?: string }): number {
  const platform = process.platform;
  const entry = catalogEntry(app, platform);
  const det = detectApp(app);

  if (app === 'blender') {
    if (!det.installed) {
      log.error('Blender was not detected on this machine. Install Blender first, then re-run.');
      log.gray('  (checked PATH + Program Files / Applications / flatpak / snap)');
      return 1;
    }
    const server = serverSpecFor('blender', platform);
    // Tag it so a future catalog change is unambiguously re-resolvable by the sync
    // migration (migrateCreativeMcpEntries), even without a name match.
    server._meta = { ...(server._meta || {}), catalogId: 'blender' };
    const user = loadProjectUserMcp(root);
    user[entry.serverName] = server;
    saveProjectUserMcp(root, user);
    sync(root);
    log.success(`Configured Blender MCP server "${entry.serverName}" (${det.path}).`);

    const uvx = prereqInstalled('uvx');
    if (!uvx) {
      log.warn('⚠  `uvx` is NOT on PATH — the server is written but will not start until you install uv:');
      log.plain(`    ${entry.prerequisites[0]!.installHint}`);
    }
    log.section('Next steps');
    for (const s of entry.postSetup) { log.plain(`  • ${s}`); }
    return 0;
  }

  // gimp — experimental.
  log.warn('⚠  GIMP MCP is EXPERIMENTAL — upstream ships no packaged launcher; expect manual wiring.');
  const gimpClient = (opts.gimpClient && opts.gimpClient.trim()) || undefined;
  const server = serverSpecFor('gimp', platform, { gimpClientPath: gimpClient });
  server._meta = { ...(server._meta || {}), catalogId: 'gimp' };
  const user = loadProjectUserMcp(root);
  user[entry.serverName] = server;
  saveProjectUserMcp(root, user);
  sync(root);

  if (gimpClient) {
    log.success(`Configured GIMP MCP client "${entry.serverName}" → ${gimpClient}`);
  } else {
    log.warn(`Wrote a DISABLED stub "${entry.serverName}" (args: ${GIMP_CLIENT_PLACEHOLDER}). Provide --gimp-client <path> to complete it.`);
  }
  if (!prereqInstalled('python')) {
    log.warn('⚠  No python/python3 on PATH:');
    log.plain(`    ${entry.prerequisites[0]!.installHint}`);
  }
  log.section('Manual steps');
  for (const s of entry.postSetup) { log.plain(`  • ${s}`); }
  for (const n of entry.notes) { log.gray(`  ! ${n}`); }
  return 0;
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function mcpCommand(program: Command): void {
  const cmd = program
    .command('mcp')
    .description('Manage this workspace\'s MCP servers (.mcp.json) and detect creative apps');

  // autodev mcp list [path] [--json]
  cmd
    .command('list [path]')
    .description('List MCP servers configured for this workspace')
    .option('--json', 'Output the raw entries array as JSON')
    .action((p: string | undefined, opts: { json?: boolean }) => {
      const root = resolveRoot(p);
      const all = loadProjectAllMcp(root);
      if (opts.json) {
        const arr = Object.entries(all).map(([name, e]) => ({ name, ...e }));
        process.stdout.write(JSON.stringify(arr, null, 2) + '\n');
        return;
      }
      log.section('🔌  MCP servers');
      const names = Object.keys(all);
      if (names.length === 0) { log.gray('  (none configured)'); return; }
      for (const name of names) {
        const e = all[name]!;
        const kind = e._meta?.kind === 'builtin' ? 'builtin' : 'user';
        const enabled = e.enabled === false ? 'disabled' : 'enabled';
        const detail = isRemoteMcp(e) ? e.url : [e.command, ...(e.args ?? [])].join(' ');
        log.plain(`  ${name.padEnd(20)} ${kind.padEnd(8)} ${enabled.padEnd(9)} ${transportOf(e).padEnd(6)} ${detail}`);
      }
    });

  // autodev mcp add <name> [options] [path]
  cmd
    .command('add <name> [path]')
    .description('Add a user MCP server (stdio via --command, or remote via --url)')
    .option('--command <c>', 'stdio launcher (e.g. uvx, npx, python)')
    .option('--arg <a>', 'stdio argument (repeatable; use --arg=-y for dash-prefixed values)', collect, [])
    .option('--env <kv>', 'stdio env var KEY=VALUE (repeatable)', collect, [])
    .option('--url <u>', 'remote MCP endpoint URL (http/sse)')
    .option('--header <kv>', 'remote header KEY=VALUE (repeatable)', collect, [])
    .option('--sse', 'remote transport is SSE (default http)')
    .action((name: string, p: string | undefined, opts: {
      command?: string; arg?: string[]; env?: string[];
      url?: string; header?: string[]; sse?: boolean;
    }) => {
      const root = resolveRoot(p);
      if (opts.command && opts.url) {
        log.error('Provide EITHER --command (stdio) OR --url (remote), not both.');
        process.exit(1);
      }
      if (!opts.command && !opts.url) {
        log.error('Provide --command <c> for a stdio server or --url <u> for a remote server.');
        process.exit(1);
      }
      let entry: McpJsonEntry;
      if (opts.url) {
        entry = {
          type: opts.sse ? 'sse' : 'http',
          url: opts.url,
          ...(parseKvPairs(opts.header) ? { headers: parseKvPairs(opts.header) } : {}),
        };
      } else {
        entry = {
          command: opts.command!,
          args: opts.arg ?? [],
          ...(parseKvPairs(opts.env) ? { env: parseKvPairs(opts.env) } : {}),
        };
      }
      const user = loadProjectUserMcp(root);
      user[name] = entry;
      saveProjectUserMcp(root, user);
      sync(root);
      log.success(`Added MCP server "${name}" and propagated to all providers.`);
    });

  // autodev mcp remove <name> [path]
  cmd
    .command('remove <name> [path]')
    .alias('rm')
    .description('Remove a user MCP server')
    .action((name: string, p: string | undefined) => {
      const root = resolveRoot(p);
      const removed = removeProjectUserMcp(root, name);
      if (!removed) {
        log.error(`No user MCP server named "${name}" (built-ins are managed via enable/disable).`);
        process.exit(1);
      }
      sync(root);
      log.success(`Removed MCP server "${name}".`);
    });

  // autodev mcp resync [path]
  cmd
    .command('resync [path]')
    .description('Re-sync MCP servers to every provider (also migrates stale creative-app servers to the current catalog)')
    .action((p: string | undefined) => {
      const root = resolveRoot(p);
      sync(root);
      log.success('Re-synced MCP servers to all providers (creative-app entries migrated to the current catalog).');
    });

  // autodev mcp enable <name> [path]
  cmd
    .command('enable <name> [path]')
    .description('Enable an MCP server (user entry or built-in)')
    .action((name: string, p: string | undefined) => {
      const root = resolveRoot(p);
      setEnabled(root, name, true);
    });

  // autodev mcp disable <name> [path]
  cmd
    .command('disable <name> [path]')
    .description('Disable an MCP server (kept in config; not synced to providers)')
    .action((name: string, p: string | undefined) => {
      const root = resolveRoot(p);
      setEnabled(root, name, false);
    });

  // autodev mcp catalog [--json]
  cmd
    .command('catalog')
    .description('List the known/pickable MCP servers (single source of truth for the app + extension picker)')
    .option('--json', 'Output the stable catalog JSON (the shape the app + extension consume)')
    .action((opts: { json?: boolean }) => {
      const result = buildCatalog();
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      log.section('🗂️  MCP server catalog');
      for (const s of result.servers) {
        const exp = s.experimental ? ' (experimental)' : '';
        log.plain(`  ${s.id.padEnd(20)} ${s.kind.padEnd(9)} ${s.transport.padEnd(6)} ${s.description}${exp}`);
      }
      log.plain('');
      log.gray('  Built-ins are the always-applied baseline (toggle via mcp enable/disable).');
      log.gray('  Add a common/creative one with:  autodev mcp add <name> --command <c> --arg <a>');
    });

  // autodev mcp detect [path] [--json] [--enable <app>] [--gimp-client <path>]
  cmd
    .command('detect [path]')
    .description('Detect installed creative apps (Blender / GIMP) and optionally enable their MCP server')
    .option('--json', 'Output the stable detection JSON (consumed by the app + extension)')
    .option('--enable <app>', 'Write + propagate the MCP server for this app (blender | gimp)')
    .option('--gimp-client <path>', 'Path to gimp_mcp_client.py (for --enable gimp)')
    .action((p: string | undefined, opts: { json?: boolean; enable?: string; gimpClient?: string }) => {
      const root = resolveRoot(p);

      if (opts.enable) {
        const app = opts.enable.toLowerCase();
        if (app !== 'blender' && app !== 'gimp') {
          log.error(`--enable expects "blender" or "gimp" (got "${opts.enable}").`);
          process.exit(1);
        }
        const code = enableApp(root, app as CreativeAppId, { gimpClient: opts.gimpClient });
        if (code !== 0) { process.exit(code); }
        return;
      }

      const result = buildDetect(root);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      log.section('🎨  Creative-app MCP detection');
      for (const a of result.apps) {
        const mark = a.installed ? '✅' : '⬜';
        const exp = a.experimental ? ' (experimental)' : '';
        log.plain(`  ${mark} ${a.name}${exp}`);
        if (a.installed) { log.gray(`       path: ${a.path}  [${a.source}]`); }
        if (a.alreadyEnabled) { log.gray('       already configured in this workspace'); }
        for (const pr of a.prerequisites) {
          if (!pr.installed) { log.warn(`       prerequisite "${pr.id}" missing → ${pr.installHint}`); }
        }
      }
      log.plain('');
      log.gray('  Enable one with:  autodev mcp detect --enable blender');
      log.gray('  GIMP (experimental): autodev mcp detect --enable gimp --gimp-client <gimp_mcp_client.py>');
    });
}

/** Flip enabled state for a user entry, or toggle disabledBuiltinMcp for a built-in. */
function setEnabled(root: string, name: string, enabled: boolean): void {
  if (isBuiltinName(root, name)) {
    const settings = loadSettingsForRoot(root);
    const disabled = new Set(settings.disabledBuiltinMcp ?? []);
    if (enabled) { disabled.delete(name); } else { disabled.add(name); }
    settings.disabledBuiltinMcp = [...disabled];
    saveSettings(root, settings);
    sync(root);
    log.success(`${enabled ? 'Enabled' : 'Disabled'} built-in MCP server "${name}".`);
    return;
  }

  const user = loadProjectUserMcp(root);
  const entry = user[name];
  if (!entry) {
    log.error(`No MCP server named "${name}" in this workspace.`);
    process.exit(1);
  }
  if (enabled) { delete entry.enabled; } else { entry.enabled = false; }
  saveProjectUserMcp(root, user);
  sync(root);
  log.success(`${enabled ? 'Enabled' : 'Disabled'} MCP server "${name}".`);
}
