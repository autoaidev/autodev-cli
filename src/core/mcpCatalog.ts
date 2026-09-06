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

/** Placeholder the GIMP stub carries until the user points it at their checkout. */
export const GIMP_CLIENT_PLACEHOLDER = '<GIMP_MCP_CLIENT_PY>';

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
 *  - GIMP: a best-effort stdio stub `python <client.py>`, written enabled:false
 *    unless the caller supplies a real client path — GIMP ships no launcher, so
 *    we never pretend it's one-click.
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
  // gimp — experimental stub.
  const client = (opts?.gimpClientPath && opts.gimpClientPath.trim()) || GIMP_CLIENT_PLACEHOLDER;
  const isStub = client === GIMP_CLIENT_PLACEHOLDER;
  return {
    command: platform === 'win32' ? 'python' : 'python3',
    args: [client],
    // A stub (no real client path) is written disabled so it is preserved for the
    // user to complete without being spawned as a broken server.
    ...(isStub ? { enabled: false } : {}),
  };
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
      prerequisites: [{ id: 'python', installHint: pythonInstallHint(platform) }],
      postSetup: [
        'Clone https://github.com/libreearth/gimp-mcp and point the server at its gimp_mcp_client.py',
        '`pip install mcp` (the client needs the MCP Python SDK)',
        gimpPluginStep(platform),
        'In GIMP 3.0: Filters → Development → Start MCP Server (socket on :9876)',
        'Re-run `autodev mcp detect --enable gimp --gimp-client <path-to-gimp_mcp_client.py>` once you have the client',
      ],
      notes: [
        'Experimental prototype: upstream ships NO packaged launcher and the README contradicts its own code — expect manual wiring.',
        'Port 9876 collides with Blender — do not run both MCP servers at once.',
      ],
    },
  ];
}

/** GIMP 3.0 plug-ins directory step, per OS. */
function gimpPluginStep(platform: NodeJS.Platform): string {
  const dir = platform === 'win32'
    ? '%APPDATA%\\GIMP\\3.0\\plug-ins\\'
    : platform === 'darwin'
      ? '~/Library/Application Support/GIMP/3.0/plug-ins/'
      : '~/.config/GIMP/3.0/plug-ins/';
  return `Copy gimp_mcp_server.py into the GIMP 3.0 plug-ins dir (${dir}) and make it executable`;
}

/** Lookup a single catalog entry. */
export function catalogEntry(app: CreativeAppId, platform: NodeJS.Platform): McpCatalogEntry {
  const e = getCatalog(platform).find((x) => x.id === app);
  if (!e) { throw new Error(`Unknown creative app: ${app}`); }
  return e;
}
