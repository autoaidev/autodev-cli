// ---------------------------------------------------------------------------
// mcpCatalog — the known creative-app MCP registry. Single source of truth that
// BOTH the Electron app and the VS Code extension consume via `autodev mcp
// detect --json`; the CLI is what actually writes the server into .mcp.json and
// propagates it to every provider, so the shapes here must stay stable.
//
// Each app declares: the McpJsonEntry we would write (platform-aware),
// prerequisites (with an install hint), and honest post-setup / notes. GIMP is
// flagged experimental because upstream ships no packaged launcher — see below.
// ---------------------------------------------------------------------------

import type { McpJsonEntry } from './projectMcp';

export type CreativeAppId = 'blender' | 'gimp';

export interface McpPrerequisiteSpec {
  /** Launcher/interpreter the server needs on PATH (e.g. 'uvx', 'python'). */
  id: string;
  /** Copy-pasteable command to install it, per platform. */
  installHint: string;
}

export interface McpCatalogEntry {
  id: CreativeAppId;
  name: string;
  /** True = prototype/best-effort. UIs should surface it as such, never one-click. */
  experimental: boolean;
  /** The name the server is written under in .mcp.json. */
  serverName: string;
  prerequisites: McpPrerequisiteSpec[];
  /** Ordered manual steps the user still performs after the config is written. */
  postSetup: string[];
  /** Caveats worth surfacing (port clashes, upstream bugs). */
  notes: string[];
}

/**
 * Display placeholder for the gimp client path BEFORE install (path unknown).
 * `serverSpecFor('gimp', …)` with no resolved client path emits this so the
 * catalog/detect JSON never bakes in a machine-specific path — and, crucially,
 * never the broken raw-github upstream client. It also lets the migration
 * recognise a not-yet-resolved gimp entry and upgrade it once GIMP is detected.
 */
export const GIMP_CLIENT_PLACEHOLDER = '<GIMP config>/mcp/gimp_mcp_client.py';

/**
 * The pinned mcp SDK version the client runs under. Load-bearing — current mcp
 * releases break the client on a removed `description=` kwarg. `uv run --with
 * mcp==1.2.0 <client>` installs exactly this into an ephemeral env.
 */
export const GIMP_MCP_PIN = 'mcp==1.2.0';

/** Per-platform install hint for the `uv`/`uvx` toolchain (never `pip install uv`). */
export function uvInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"';
  }
  if (platform === 'darwin') {
    return 'brew install uv   (or: curl -LsSf https://astral.sh/uv/install.sh | sh)';
  }
  return 'curl -LsSf https://astral.sh/uv/install.sh | sh';
}

/** Per-platform install hint for Python 3. */
export function pythonInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'win32') { return 'Install Python 3 from https://www.python.org/downloads/ (tick "Add to PATH")'; }
  if (platform === 'darwin') { return 'brew install python   (or install from https://www.python.org)'; }
  return 'Install python3 via your package manager (e.g. apt install python3)';
}

/** Per-platform install hint for git (the Blender Lab client clones a git repo via uvx). */
export function gitInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'win32') { return 'Install Git from https://git-scm.com/download/win (tick "Add to PATH")'; }
  if (platform === 'darwin') { return 'brew install git   (or: xcode-select --install)'; }
  return 'Install git via your package manager (e.g. apt install git)';
}

/**
 * The official Blender Lab MCP client, pinned to the user-verified tag. This is
 * the client that matches the "MCP from Blender Lab" add-on shipped inside
 * Blender (protocol `{"type":"execute",...}\0` on localhost:9876). It is a
 * DIFFERENT project from the community PyPI `blender-mcp` (ahujasid/blender-mcp,
 * bare `uvx blender-mcp`) which speaks an incompatible `get_addon_info` protocol
 * and collides on the same name + port — see notes on the catalog entry. `uvx
 * --from git+…` makes uv clone the Lab repo (hence the extra `git` prerequisite).
 */
export const BLENDER_LAB_FROM =
  'git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp';
const BLENDER_LAB_ARGS = ['--from', BLENDER_LAB_FROM, '--with', 'mcp<2', 'blender-mcp'];

/**
 * The McpJsonEntry we would write for an app. Platform-aware.
 *  - Blender: the OFFICIAL Blender Lab client via bare `uvx --from git+…lab…#subdirectory=mcp
 *    --with "mcp<2" blender-mcp` (uvx resolved from PATH). This matches the "MCP
 *    from Blender Lab" add-on. NEVER bare `uvx blender-mcp` (no --from) — that
 *    pulls the incompatible community PyPI package. (The exact launcher form is
 *    under review; the args are the load-bearing part the migration re-resolves.)
 *  - GIMP: the LOCALLY-INSTALLED, user-verified client run by bare `uv`
 *    (`uv run --with mcp==1.2.0 <clientPath>`) on every platform. `clientPath`
 *    is the client installGimpPlugin() writes to <GIMP-config>/<ver>/mcp/. Pass
 *    the resolved path via `opts.gimpClientPath`; without it we emit the display
 *    placeholder (never the broken raw-github upstream client). Experimental.
 */
export function serverSpecFor(
  app: CreativeAppId,
  platform: NodeJS.Platform,
  opts?: { gimpClientPath?: string },
): McpJsonEntry {
  if (app === 'blender') {
    // command is bare `uvx` (resolved from PATH) on every platform; args carry the
    // official Blender Lab `--from git+…lab…` client.
    return { command: 'uvx', args: [...BLENDER_LAB_ARGS] };
  }
  // gimp — run the locally-installed client via `uv` with the pinned mcp SDK.
  // Same command shape on every platform; only the client path differs.
  const client = (opts?.gimpClientPath && opts.gimpClientPath.trim()) || GIMP_CLIENT_PLACEHOLDER;
  return { command: 'uv', args: ['run', '--with', GIMP_MCP_PIN, client] };
}

/** The client-path argument carried by a gimp .mcp.json entry, whatever the command form. */
export function gimpClientArgOf(entry: { command?: string; args?: string[] }): string | undefined {
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (entry.command === 'python' || entry.command === 'python3') { return args[0]; }
  if (entry.command === 'uv') { return args[args.length - 1]; }
  return undefined;
}

/**
 * Is `arg` a CONCRETE local client path — a real filesystem path we must not
 * clobber (a user's own checkout, or the client we already installed)? False for
 * the display placeholder and for ANY URL (incl. the broken raw-github client).
 */
export function isConcreteGimpClientArg(arg: string | undefined): boolean {
  if (typeof arg !== 'string' || arg.length === 0) { return false; }
  if (arg === GIMP_CLIENT_PLACEHOLDER) { return false; }
  if (/^https?:\/\//i.test(arg)) { return false; }
  if (/raw\.githubusercontent\.com/i.test(arg)) { return false; }
  return true;
}

/** Build the catalog for a given platform (install hints are platform-specific). */
export function getCatalog(platform: NodeJS.Platform): McpCatalogEntry[] {
  return [
    {
      id: 'blender',
      name: 'Blender',
      experimental: false,
      serverName: 'blender',
      prerequisites: [
        { id: 'uvx', installHint: uvInstallHint(platform) },
        { id: 'git', installHint: gitInstallHint(platform) },
      ],
      postSetup: [
        "In Blender: Edit → Preferences → Add-ons → enable 'MCP from Blender Lab' (Host localhost, Port 9876). Keep Blender open — the add-on only works while Blender is running.",
        "Do NOT install or enable the community 'MCP for Blender' add-on, and do NOT run `uvx blender-mcp install-addon` — that is a DIFFERENT, incompatible project (wrong protocol) that collides on the same name + port 9876.",
        'First start is slow — the Lab client clones its git repo and loads the full Blender docs; allow ~90s. If your runner kills MCP startup early, raise its startup timeout (for Grok: set env `GROK_MCP_STARTUP_TIMEOUT_SECS=90`, since Grok ignores `startup_timeout_sec` in config.toml).',
        'Run only one MCP client against Blender at a time',
      ],
      notes: [
        'Two different projects share the name "blender-mcp" AND port 9876 with INCOMPATIBLE protocols: the official Blender Lab client (this entry) and the community PyPI package (ahujasid/blender-mcp). This entry uses the official Blender Lab client (`uvx --from git+…projects.blender.org/lab/blender_mcp…`) which matches the "MCP from Blender Lab" add-on.',
        'Never run bare `uvx blender-mcp` — it pulls the community PyPI package, which speaks a different (get_addon_info) protocol the Lab add-on never answers, so the client times out and gets killed.',
      ],
    },
    {
      id: 'gimp',
      name: 'GIMP',
      experimental: true,
      serverName: 'gimp',
      prerequisites: [{ id: 'uv', installHint: uvInstallHint(platform) }],
      postSetup: [
        `Plugin + client are installed automatically into your GIMP 3.x config (${gimpPluginDir(platform)}) — you copy nothing. Re-run any time with: autodev mcp gimp-install-plugin`,
        "In GIMP: Tools → MCP → Start MCP Server (or Filters → Development → Start MCP Server), and KEEP the 'GIMP MCP Server' window open — it holds the plug-in process alive and the :9877 socket. One click per GIMP session (the window may hide behind other apps; use the taskbar).",
        'Requires GIMP 3.x (the plugin uses the GIMP 3.0 Python API).',
        'GIMP MCP uses port 9877; Blender uses 9876, so they no longer collide and can run together.',
      ],
      notes: [
        `Log: ${gimpLogPath(platform)} (Store/MSIX GIMP also mirrors a copy inside its sandbox LocalCache).`,
        `The client runs via \`uv run --with ${GIMP_MCP_PIN} <installed client>\`; the ${GIMP_MCP_PIN} pin is load-bearing (current mcp releases break the client on a removed description= kwarg).`,
        'GIMP 3.2.4 can crash (access-violation) on TextLayer merge_down/merge_filter — rasterize text via Gimp.Layer.new_from_visible first, then filter/merge the raster copy.',
      ],
    },
  ];
}

/** GIMP 3.x config directory, per OS (where plug-ins/ and mcp/ get installed). */
function gimpPluginDir(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '%APPDATA%\\GIMP\\3.x\\'
    : platform === 'darwin'
      ? '~/Library/Application Support/GIMP/3.x/'
      : '~/.config/GIMP/3.x/';
}

/** GIMP MCP server log path, per OS (dual-written by the plug-in). */
function gimpLogPath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '%APPDATA%\\GIMP\\3.x\\gimp_mcp_server.log'
    : platform === 'darwin'
      ? '~/Library/Application Support/GIMP/3.x/gimp_mcp_server.log'
      : '~/.config/GIMP/3.x/gimp_mcp_server.log';
}

/** Lookup a single catalog entry. */
export function catalogEntry(app: CreativeAppId, platform: NodeJS.Platform): McpCatalogEntry {
  const e = getCatalog(platform).find((x) => x.id === app);
  if (!e) { throw new Error(`Unknown creative app: ${app}`); }
  return e;
}

// ---------------------------------------------------------------------------
// Remote catalog — hosted, Streamable-HTTP MCP endpoints (NOT local apps). These
// require a per-agent bearer key in an Authorization header, so unlike the
// creative entries they can't be one-click "Add"ed without a key. The catalog
// SERVER spec here NEVER carries a key (no secret baked into the shared catalog
// JSON); the key is injected at enable-time via remoteServerSpec(entry, key) and
// stored only in the owner-only .mcp.json. SyntheticMem is the first entry.
// ---------------------------------------------------------------------------

/** SyntheticMem — permanent, provenance-aware agent memory over remote MCP. */
export const SYNTHETICMEM_MCP_URL = 'https://syntheticmem.com/api/mcp';
/** POST here (no body needed) for a free, anonymous 24h demo key. Rate-limited 5/hr/IP. */
export const SYNTHETICMEM_DEMO_KEY_URL = 'https://syntheticmem.com/api/demo-key';
/** Register here to mint a permanent per-agent key (demo keys expire in 24h). */
export const SYNTHETICMEM_REGISTER_URL = 'https://syntheticmem.com/app';
/** The bearer key prefix SyntheticMem issues. */
export const SYNTHETICMEM_KEY_PREFIX = 'agt_';

export interface RemoteCatalogEntry {
  /** Stable id (the .mcp.json key the server is written under). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description for pickers. */
  description: string;
  /** The remote Streamable-HTTP MCP endpoint. */
  url: string;
  /** Header name carrying the bearer key (e.g. 'Authorization'). */
  authHeader: string;
  /** Expected key prefix (e.g. 'agt_') — used for a soft validation hint only. */
  keyPrefix: string;
  /** Optional endpoint that POSTs back a free ephemeral key `{ key, mcp_url, ttl_hours }`. */
  demoKeyUrl?: string;
  /** Where to register for a permanent key. */
  registerUrl?: string;
  /** Caveats worth surfacing. */
  notes: string[];
}

/** The known remote (hosted) MCP servers the UIs offer as OPTIONAL, off-by-default entries. */
export function getRemoteCatalog(): RemoteCatalogEntry[] {
  return [
    {
      id: 'syntheticmem',
      name: 'SyntheticMem — permanent agent memory',
      description: 'Permanent, provenance-aware memory + semantic recall (remote MCP)',
      url: SYNTHETICMEM_MCP_URL,
      authHeader: 'Authorization',
      keyPrefix: SYNTHETICMEM_KEY_PREFIX,
      demoKeyUrl: SYNTHETICMEM_DEMO_KEY_URL,
      registerUrl: SYNTHETICMEM_REGISTER_URL,
      notes: [
        `Needs a per-agent key (${SYNTHETICMEM_KEY_PREFIX}…). Get one free (no signup, 24h) with a demo key, or register at ${SYNTHETICMEM_REGISTER_URL} for a permanent key.`,
        'Demo keys are EPHEMERAL: memories saved under a demo key expire in 24h. Register to keep them permanently.',
      ],
    },
  ];
}

/** Lookup a single remote catalog entry by id (undefined if not a known remote server). */
export function remoteCatalogEntry(id: string): RemoteCatalogEntry | undefined {
  return getRemoteCatalog().find((e) => e.id === id);
}

/**
 * The remote McpJsonEntry for a remote catalog entry. When `key` is given, the
 * bearer is written into the auth header; without it the entry carries NO headers
 * (the shared catalog JSON never embeds a secret). The key is trimmed and, if it
 * doesn't already look like a scheme, prefixed with `Bearer `.
 */
export function remoteServerSpec(entry: RemoteCatalogEntry, key?: string): McpJsonEntry {
  const k = (key ?? '').trim();
  if (!k) { return { type: 'http', url: entry.url }; }
  const value = /^bearer\s/i.test(k) ? k : `Bearer ${k}`;
  return { type: 'http', url: entry.url, headers: { [entry.authHeader]: value } };
}

/** Mask a bearer/agt key for safe display/logging: keep the prefix + last 4, redact the middle. */
export function maskKey(key: string | undefined): string {
  const k = (key ?? '').trim();
  if (!k) { return '(none)'; }
  const tail = k.slice(-4);
  const head = k.length > 8 ? k.slice(0, 4) : '';
  return `${head}…${tail}`;
}
