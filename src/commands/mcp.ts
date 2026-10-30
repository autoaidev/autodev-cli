import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import {
  loadProjectAllMcp, loadProjectUserMcp, saveProjectUserMcp, removeProjectUserMcp,
  isRemoteMcp, type McpJsonEntry,
} from '../core/projectMcp';
import { ConfigManager } from '../configManager';
import { DEFAULT_MCP_SERVERS, CORE_BUILTIN_NAMES } from '../mcpManager';
import { detectApp, detectBinOnPath, type BinDetectDeps, type DetectAppResult } from '../core/binDetect';
import {
  getCatalog, serverSpecFor, catalogEntry, GIMP_MCP_PIN,
  getRemoteCatalog, remoteCatalogEntry, remoteServerSpec, maskKey,
  type CreativeAppId, type RemoteCatalogEntry,
} from '../core/mcpCatalog';
import {
  loadSettingsForRoot, settingsWritePath, type AutodevSettings,
} from '../core/settingsLoader';
import { writeFileSecure } from '../core/secureFile';
import { installGimpPlugin, type GimpInstallResult } from '../core/gimpPluginInstall';

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

/** Is a prerequisite launcher present on PATH? (uv / uvx / git / python[3]). */
function prereqInstalled(id: string, deps?: Partial<BinDetectDeps>): boolean {
  if (id === 'python') {
    return !!(detectBinOnPath('python3', deps) || detectBinOnPath('python', deps));
  }
  // Every other id (uv, uvx, git, …) is a bare launcher name resolved on PATH.
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

export type CatalogKind = 'builtin' | 'common' | 'creative' | 'remote';

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
  /**
   * Present for 'remote' entries that require a bearer key. Tells the UIs to show
   * a key field + (optional) a one-click demo-key button + a register link — the
   * server spec above NEVER carries a key, so a keyless one-click add is invalid.
   */
  auth?: {
    header: string;
    keyPrefix: string;
    demoKeyUrl?: string;
    registerUrl?: string;
  };
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

  // 4) remote — hosted MCP endpoints (SyntheticMem, …) that need a per-agent
  // bearer key. The server spec carries NO key (no secret in the shared catalog);
  // `auth` tells the UIs to collect a key / offer a demo key before enabling.
  for (const entry of getRemoteCatalog()) {
    servers.push({
      id: entry.id,
      name: entry.name,
      kind: 'remote',
      transport: 'http',
      server: remoteServerSpec(entry),
      description: entry.description,
      experimental: false,
      auth: {
        header: entry.authHeader,
        keyPrefix: entry.keyPrefix,
        demoKeyUrl: entry.demoKeyUrl,
        registerUrl: entry.registerUrl,
      },
    });
  }

  return { servers };
}

// ---------------------------------------------------------------------------
// Remote-server key handling — fetch a free ephemeral demo key, and write a
// remote catalog server (SyntheticMem) with its Authorization header. The key is
// NEVER logged; only a masked form is ever printed.
// ---------------------------------------------------------------------------

export interface DemoKeyResult {
  key: string;
  mcpUrl?: string;
  ttlHours?: number;
}

/**
 * POST the remote server's demo-key endpoint for a free, anonymous, ephemeral key.
 * Throws a readable error on a non-2xx (incl. the 429 rate limit) or a response
 * that doesn't carry a plausible key. Uses the global `fetch` (Node 18+).
 */
export async function fetchRemoteDemoKey(entry: RemoteCatalogEntry): Promise<DemoKeyResult> {
  if (!entry.demoKeyUrl) { throw new Error(`"${entry.id}" has no demo-key endpoint.`); }
  let res: Response;
  try {
    res = await fetch(entry.demoKeyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
  } catch (e) {
    throw new Error(`could not reach ${entry.demoKeyUrl}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error('demo-key rate limit reached (5/hour per IP) — try again later, or paste an existing key.');
    }
    throw new Error(`demo-key request failed (HTTP ${res.status}).`);
  }
  let data: unknown;
  try { data = await res.json(); } catch { throw new Error('demo-key response was not valid JSON.'); }
  const obj = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
  // SyntheticMem (and its ProvisionController family) return the minted key as
  // `token`; read that canonically, with `key` as a back-compat fallback.
  const rawKey = typeof obj.token === 'string' ? obj.token
    : typeof obj.key === 'string' ? obj.key
    : '';
  const key = rawKey.trim();
  if (!key || !key.startsWith(entry.keyPrefix)) {
    throw new Error(`demo-key response did not include a valid ${entry.keyPrefix}… key.`);
  }
  return {
    key,
    mcpUrl: typeof obj.mcp_url === 'string' ? obj.mcp_url : undefined,
    ttlHours: typeof obj.ttl_hours === 'number' ? obj.ttl_hours : undefined,
  };
}

/** Write a remote catalog server (with its bearer key) into .mcp.json + propagate. Key never logged. */
function enableRemote(root: string, entry: RemoteCatalogEntry, key: string, opts?: { demo?: boolean; ttlHours?: number }): void {
  const server = remoteServerSpec(entry, key);
  server._meta = { ...(server._meta || {}), catalogId: entry.id };
  const user = loadProjectUserMcp(root);
  user[entry.id] = server;
  saveProjectUserMcp(root, user);
  sync(root);
  log.success(`Added MCP server "${entry.id}" (${entry.url}) with key ${maskKey(key)} and propagated to all providers.`);
  if (opts?.demo) {
    const ttl = opts.ttlHours ?? 24;
    log.warn(`⚠  This is an EPHEMERAL demo key — memories saved under it expire in ~${ttl}h.`);
    log.gray(`   Register at ${entry.registerUrl} for a permanent key, then re-add with --key <your key>.`);
  }
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

  // gimp — experimental. Install BOTH the GIMP-side plug-in AND the user-verified
  // client FIRST so we can point the MCP config at the client's absolute path.
  // --gimp-client stays an OPTIONAL override for a user's own checkout.
  log.warn('⚠  GIMP MCP is EXPERIMENTAL — a prototype; expect rough edges.');
  const gimpClientOverride = (opts.gimpClient && opts.gimpClient.trim()) || undefined;

  // Install both files (best-effort). A failure must not block the config write.
  let installedClientPath: string | undefined;
  try {
    const res = installGimpPlugin();
    if (res.installed && res.clientPath) { installedClientPath = res.clientPath; }
    printGimpInstall(res);
  } catch (e) {
    log.warn(`⚠  Could not install the GIMP plugin/client: ${(e as Error).message}`);
    log.gray('   You can retry with:  autodev mcp gimp-install-plugin');
  }

  // Point the MCP config at the installed client (or the user's override). When
  // neither is known (GIMP absent), serverSpecFor emits the display placeholder.
  const clientPath = gimpClientOverride || installedClientPath;
  const server = serverSpecFor('gimp', platform, { gimpClientPath: clientPath });
  server._meta = { ...(server._meta || {}), catalogId: 'gimp' };
  const user = loadProjectUserMcp(root);
  user[entry.serverName] = server;
  saveProjectUserMcp(root, user);
  sync(root);

  if (clientPath) {
    log.success(`Configured GIMP MCP server "${entry.serverName}" → uv run ${GIMP_MCP_PIN} ${clientPath}`);
  } else {
    log.success(`Configured GIMP MCP server "${entry.serverName}".`);
    log.gray('   (client path unknown until GIMP 3.x is present — re-run after installing GIMP)');
  }
  if (!prereqInstalled('uv')) {
    log.warn('⚠  `uv` is NOT on PATH — the server is written but will not start until you install uv:');
    log.plain(`    ${entry.prerequisites[0]!.installHint}`);
  }

  log.section('Manual steps');
  for (const s of entry.postSetup) { log.plain(`  • ${s}`); }
  for (const n of entry.notes) { log.gray(`  ! ${n}`); }
  return 0;
}

/** Pretty-print an installGimpPlugin() result (shared by --enable + standalone). */
function printGimpInstall(res: GimpInstallResult): void {
  if (res.installed) {
    log.success(`Installed the GIMP MCP plugin + client (GIMP ${res.version}).`);
    for (const p of res.paths) { log.plain(`    plug-in: ${p}`); }
    for (const p of res.clientPaths) { log.plain(`    client:  ${p}`); }
    log.plain("  In GIMP: Tools → MCP → Start MCP Server (or Filters → Development), and KEEP the");
    log.plain("  'GIMP MCP Server' window open — it holds the plug-in alive on localhost:9877.");
  } else {
    log.warn('⚠  The GIMP MCP plugin was NOT installed.');
  }
  for (const w of res.warnings) { log.gray(`  ! ${w}`); }
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
    .description('Add a user MCP server (stdio via --command, remote via --url, or a known catalog server by name + --key/--demo-key)')
    .option('--command <c>', 'stdio launcher (e.g. uvx, npx, python)')
    .option('--arg <a>', 'stdio argument (repeatable; use --arg=-y for dash-prefixed values)', collect, [])
    .option('--env <kv>', 'stdio env var KEY=VALUE (repeatable)', collect, [])
    .option('--url <u>', 'remote MCP endpoint URL (http/sse)')
    .option('--header <kv>', 'remote header KEY=VALUE (repeatable)', collect, [])
    .option('--sse', 'remote transport is SSE (default http)')
    .option('--key <k>', 'bearer key for a known remote catalog server (e.g. a SyntheticMem agt_ key)')
    .option('--demo-key', 'fetch a free ephemeral key for a known remote catalog server (SyntheticMem)')
    .action(async (name: string, p: string | undefined, opts: {
      command?: string; arg?: string[]; env?: string[];
      url?: string; header?: string[]; sse?: boolean;
      key?: string; demoKey?: boolean;
    }) => {
      const root = resolveRoot(p);

      // Catalog shortcut: `mcp add <knownRemote>` (no --command/--url) writes the
      // remote server from the catalog, injecting the user's bearer key. This is
      // the single, CLI-owned writer the app + extension reuse — not a parallel one.
      if (!opts.command && !opts.url) {
        const remote = remoteCatalogEntry(name);
        if (remote) {
          let key = (opts.key ?? '').trim();
          let usedDemo = false;
          let ttlHours: number | undefined;
          if (!key && opts.demoKey) {
            try {
              const demo = await fetchRemoteDemoKey(remote);
              key = demo.key; usedDemo = true; ttlHours = demo.ttlHours;
            } catch (e) {
              log.error(`Could not fetch a demo key: ${(e as Error).message}`);
              process.exit(1);
            }
          }
          if (!key) {
            log.error(`"${name}" is a remote server that needs a key. Pass --key <${remote.keyPrefix}…> (register at ${remote.registerUrl}) or --demo-key for a free 24h key.`);
            process.exit(1);
          }
          enableRemote(root, remote, key, { demo: usedDemo, ttlHours });
          return;
        }
      }

      if (opts.command && opts.url) {
        log.error('Provide EITHER --command (stdio) OR --url (remote), not both.');
        process.exit(1);
      }
      if (!opts.command && !opts.url) {
        log.error('Provide --command <c> for a stdio server, --url <u> for a remote server, or a known catalog name (e.g. syntheticmem) with --key/--demo-key.');
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

  // autodev mcp demo-key [--json] [--server <id>]
  // Fetch a free ephemeral key for a remote catalog server (SyntheticMem). Used
  // by the app/extension "Get a free 24h demo key" button to fill the key field.
  cmd
    .command('demo-key')
    .description('Fetch a free ephemeral (24h) demo key for a remote catalog server (default: syntheticmem)')
    .option('--json', 'Output { key, mcp_url, ttl_hours } as JSON (for the app/extension to consume)')
    .option('--server <id>', 'Remote catalog server id', 'syntheticmem')
    .action(async (opts: { json?: boolean; server?: string }) => {
      const id = (opts.server || 'syntheticmem').trim();
      const remote = remoteCatalogEntry(id);
      if (!remote) {
        log.error(`"${id}" is not a known remote catalog server.`);
        process.exit(1);
      }
      let demo;
      try {
        demo = await fetchRemoteDemoKey(remote);
      } catch (e) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: (e as Error).message }) + '\n');
        } else {
          log.error(`Could not fetch a demo key: ${(e as Error).message}`);
        }
        process.exit(1);
        return;
      }
      if (opts.json) {
        // The demo key is ephemeral + requested explicitly; emit it for the UI to
        // fill its field. This is the command's RESULT, not a log line.
        process.stdout.write(JSON.stringify({
          key: demo.key,
          mcp_url: demo.mcpUrl ?? remote.url,
          ttl_hours: demo.ttlHours ?? 24,
        }) + '\n');
        return;
      }
      log.success(`Fetched a free demo key for ${remote.name} (${maskKey(demo.key)}, ~${demo.ttlHours ?? 24}h).`);
      log.plain(`  Enable it with:  autodev mcp add ${id} --demo-key`);
      log.gray(`  (or paste this key into the app/extension SyntheticMem field; register at ${remote.registerUrl} to keep memories permanently)`);
    });

  // autodev mcp gimp-install-plugin [dir]
  cmd
    .command('gimp-install-plugin [dir]')
    .description('Install the AUTO-START GIMP 3.x MCP plugin (localhost:9877 opens on GIMP launch — no menu click)')
    .action((dir: string | undefined) => {
      const res = installGimpPlugin(dir ? { targetDir: path.resolve(dir) } : undefined);
      printGimpInstall(res);
      if (!res.installed) { process.exit(1); }
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
      log.gray('  GIMP (experimental): autodev mcp detect --enable gimp   (or --gimp-client <path> for a local checkout)');
    });
}

/** Flip enabled state for a user entry, or toggle disabledBuiltinMcp for a built-in. */
function setEnabled(root: string, name: string, enabled: boolean): void {
  // The 4 core built-ins are non-disableable — refuse rather than write a
  // disabledBuiltinMcp entry the sync would ignore anyway.
  if (!enabled && CORE_BUILTIN_NAMES.has(name)) {
    log.error(`"${name}" is a built-in server and cannot be disabled.`);
    process.exit(1);
  }
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
