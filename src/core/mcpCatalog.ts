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

/**
 * The McpJsonEntry we would write for an app. Platform-aware.
 *  - Blender: `uvx blender-mcp` (wrapped in `cmd /c` on win32 so the .cmd shim resolves).
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
    return platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'uvx', 'blender-mcp'] }
      : { command: 'uvx', args: ['blender-mcp'] };
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
      prerequisites: [{ id: 'uvx', installHint: uvInstallHint(platform) }],
      postSetup: [
        'Run `uvx blender-mcp install-addon` to install the Blender addon',
        "In Blender: Preferences → Add-ons → enable 'Interface: MCP for Blender'",
        "In the 3D viewport press N → 'MCP for Blender' → Start MCP Server (listens on localhost:9876)",
        'Run only one MCP client against Blender at a time',
      ],
      notes: [],
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
