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
 * Legacy placeholder the OLD GIMP stub carried until the user pointed it at a
 * local checkout. No longer the default (see serverSpecFor/gimp below) — kept
 * ONLY so the migration can recognise + upgrade pre-git-based stubs.
 */
export const GIMP_CLIENT_PLACEHOLDER = '<GIMP_MCP_CLIENT_PY>';

/**
 * The GIMP MCP client, run straight from git by `uv` — no manual clone. Pinned
 * to a specific upstream commit + `mcp==1.2.0` for reproducibility: `uv run`
 * fetches this raw script, installs the PINNED mcp SDK, and launches the FastMCP
 * stdio server (it lazily connects to GIMP on localhost:9876, so it starts even
 * without GIMP running). Verified end-to-end (valid MCP initialize handshake,
 * clean exit). `mcp==1.2.0` is load-bearing — current mcp releases break this
 * client on a removed `description=` kwarg.
 */
export const GIMP_MCP_COMMIT = '49c46dd6146cb7393b42a9ecda630583b3117b33';
export const GIMP_MCP_CLIENT_URL =
  `https://raw.githubusercontent.com/libreearth/gimp-mcp/${GIMP_MCP_COMMIT}/gimp_mcp_client.py`;
export const GIMP_MCP_PIN = 'mcp==1.2.0';
const GIMP_GIT_ARGS = ['run', '--with', GIMP_MCP_PIN, GIMP_MCP_CLIENT_URL];

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
 *  - GIMP: the git-based client run by bare `uv` (`uv run --with mcp==1.2.0
 *    <raw github url>`) on every platform — runnable now, so written ENABLED
 *    (no disabled stub). `opts.gimpClientPath` is an OPTIONAL override for users
 *    who cloned the repo locally → `python[3] <that path>`. Still experimental.
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
  // gimp — OPTIONAL local override: a user who cloned the repo points us at their
  // gimp_mcp_client.py and we run it via python (enabled — it's a real path).
  const local = opts?.gimpClientPath && opts.gimpClientPath.trim();
  if (local && local !== GIMP_CLIENT_PLACEHOLDER) {
    return { command: platform === 'win32' ? 'python' : 'python3', args: [local] };
  }
  // Default: the git-based client, fetched + launched by `uv run`. Same on every
  // platform. Enabled by default — it launches even without GIMP present.
  return { command: 'uv', args: [...GIMP_GIT_ARGS] };
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
        'The MCP client runs from git automatically (uv fetches it) — no manual download of the client.',
        `You still need the GIMP-side plugin: download gimp_mcp_server.py from https://github.com/libreearth/gimp-mcp into your GIMP 3.x plug-ins folder (${gimpPluginDir(platform)}), restart GIMP, then Filters → Development → Start MCP Server (listens on localhost:9876).`,
        'Requires GIMP 3.0+ (the plugin uses the GIMP 3.0 API).',
        "Port 9876 collides with Blender — don't run both MCP servers at once.",
      ],
      notes: [
        'Experimental prototype: upstream is a prototype and its README contradicts its own code — expect rough edges.',
        `The client is pinned to a specific commit (${GIMP_MCP_COMMIT.slice(0, 7)}…) and ${GIMP_MCP_PIN} for reproducibility (current mcp releases break the client on a removed description= kwarg).`,
      ],
    },
  ];
}

/** GIMP 3.0 plug-ins directory, per OS (where the server-side plugin lives). */
function gimpPluginDir(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '%APPDATA%\\GIMP\\3.0\\plug-ins\\'
    : platform === 'darwin'
      ? '~/Library/Application Support/GIMP/3.0/plug-ins/'
      : '~/.config/GIMP/3.0/plug-ins/';
}

/** Lookup a single catalog entry. */
export function catalogEntry(app: CreativeAppId, platform: NodeJS.Platform): McpCatalogEntry {
  const e = getCatalog(platform).find((x) => x.id === app);
  if (!e) { throw new Error(`Unknown creative app: ${app}`); }
  return e;
}
