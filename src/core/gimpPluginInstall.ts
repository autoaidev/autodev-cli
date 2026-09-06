// ---------------------------------------------------------------------------
// gimpPluginInstall — drop the vendored, USER-VERIFIED GIMP MCP files into the
// correct GIMP 3.x user config so the socket bridge works end-to-end:
//   - the GIMP-side PLUG-IN (server) → plug-ins/gimp_mcp_server/gimp_mcp_server.py
//   - the MCP CLIENT                 → mcp/gimp_mcp_client.py   (a sibling dir)
//
// The plug-in is MENU-TRIGGERED (the user's verified flow): in GIMP the user runs
// Tools → MCP → Start MCP Server (or Filters → Development → Start MCP Server) and
// keeps the "GIMP MCP Server" window open — that holds the out-of-process plug-in
// alive and the :9876 socket. We do NOT auto-start it (the PERSISTENT approach we
// tried did not work on GIMP 3.2); we only install the files.
//
// GROUNDED RULES (see AutoDev research):
//  - GIMP 3.x user config is MINOR-versioned: GIMP 3.2 → .../GIMP/3.2/ (NOT 3.0).
//    Bases: linux $XDG_CONFIG_HOME/GIMP or ~/.config/GIMP; win32 %APPDATA%\GIMP;
//    darwin ~/Library/Application Support/GIMP. Honor GIMP3_DIRECTORY (overrides
//    the WHOLE versioned dir). Glob GIMP/3.* and pick the HIGHEST minor; if none
//    exists, create 3.0 and warn (user should launch GIMP once).
//  - GIMP 3.x layout: plug-ins/gimp_mcp_server/gimp_mcp_server.py — the .py MUST
//    sit in a sub-folder whose name == the .py basename (a loose .py is ignored).
//    On non-Windows the .py must be executable (0o755). The client sits at
//    <ver>/mcp/gimp_mcp_client.py (also 0o755 on non-Windows).
//  - Windows Store (MSIX) GIMP reads the REAL %APPDATA%\GIMP\<ver>. As a safety
//    net we ALSO write the virtualized path when a package dir exists:
//    %LOCALAPPDATA%\Packages\GIMP.<...>_*\LocalCache\Roaming\GIMP\<ver>\… .
//
// Everything is dependency-injected (platform/env/homedir/fileExists/listDir/
// mkdirp/writeFile/chmod/copyFile/readPluginSource/readClientSource/detectGimp) so
// the resolver is unit-testable without a real GIMP or filesystem.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectApp, type DetectAppResult } from './binDetect';
import { GIMP_PLUGIN_SOURCE } from './gimpPluginSource';
import { GIMP_CLIENT_SOURCE } from './gimpClientSource';

export interface GimpInstallDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fileExists: (p: string) => boolean;
  listDir: (p: string) => string[];
  mkdirp: (p: string) => void;
  writeFile: (p: string, data: string) => void;
  chmod: (p: string, mode: number) => void;
  copyFile: (src: string, dst: string) => void;
  /** Read an existing file (for idempotent-skip content comparison). '' if unreadable. */
  readFile: (p: string) => string;
  /**
   * The GIMP-side plug-in (server) source. Defaults to the EMBEDDED string
   * (GIMP_PLUGIN_SOURCE) so it works when esbuild-bundled into the VS Code
   * extension where media/gimp/gimp_mcp_server.py is NOT on disk at runtime.
   */
  readPluginSource: () => string;
  /**
   * The MCP client source. Defaults to the EMBEDDED string (GIMP_CLIENT_SOURCE),
   * same bundle-safety rationale as readPluginSource.
   */
  readClientSource: () => string;
  /** GIMP detection (to gate on major < 3). Defaults to detectApp('gimp'). */
  detectGimp: () => DetectAppResult;
}

export interface GimpInstallResult {
  installed: boolean;
  /** Primary GIMP-side plug-in .py path written (the real %APPDATA%/config one). */
  serverPath: string | null;
  /** Primary MCP client .py path written (<ver>/mcp/gimp_mcp_client.py). */
  clientPath: string | null;
  /** All plug-in (server) .py paths written (incl. the win32 Store fallback). */
  paths: string[];
  /** All MCP client .py paths written. */
  clientPaths: string[];
  /** The GIMP minor-version dir chosen (e.g. "3.2"), or null when not installed. */
  version: string | null;
  warnings: string[];
}

export interface GimpInstallOpts {
  /**
   * Explicit versioned GIMP config dir to target (e.g. `~/.config/GIMP/3.2`),
   * bypassing the auto-resolver. Same semantics as GIMP3_DIRECTORY.
   */
  targetDir?: string;
}

/** Absolute path to the vendored plug-in (server) shipped in the tarball. */
export function vendoredPluginSourcePath(): string {
  // Compiled to out/core/gimpPluginInstall.js → package root is ../../ .
  return path.join(__dirname, '..', '..', 'media', 'gimp', 'gimp_mcp_server.py');
}

/** Absolute path to the vendored MCP client shipped in the tarball. */
export function vendoredClientSourcePath(): string {
  return path.join(__dirname, '..', '..', 'media', 'gimp', 'gimp_mcp_client.py');
}

function realDeps(): GimpInstallDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir,
    fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    writeFile: (p, data) => { fs.writeFileSync(p, data); },
    chmod: (p, mode) => { try { fs.chmodSync(p, mode); } catch { /* non-POSIX fs */ } },
    copyFile: (src, dst) => { fs.copyFileSync(src, dst); },
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } },
    // Runtime uses the EMBEDDED sources (bundle-safe). media/gimp/*.py stay the
    // canonical source + GPL attribution, but are no longer read at runtime.
    readPluginSource: () => GIMP_PLUGIN_SOURCE,
    readClientSource: () => GIMP_CLIENT_SOURCE,
    detectGimp: () => detectApp('gimp'),
  };
}

/** GIMP user-config BASE dir (the folder that CONTAINS the 3.x version dirs). */
function gimpConfigBase(d: GimpInstallDeps): string {
  const home = d.homedir();
  if (d.platform === 'win32') {
    const appData = d.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'GIMP');
  }
  if (d.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'GIMP');
  }
  const xdg = d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME.trim();
  const cfg = xdg ? xdg : path.join(home, '.config');
  return path.join(cfg, 'GIMP');
}

/** Parse the numeric minor from a `3.<minor>` dir name; null if not `3.*`. */
function minorOf(name: string): number | null {
  const m = /^3\.(\d+)$/.exec(name);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Pick the HIGHEST-minor `3.*` version dir under base. Returns the chosen
 * version string and whether it already existed. When none exist, defaults to
 * "3.0" (created + warned by the caller).
 */
function chooseVersion(base: string, d: GimpInstallDeps): { version: string; existed: boolean } {
  const kids = d.listDir(base)
    .map((n) => ({ name: n, minor: minorOf(n) }))
    .filter((x): x is { name: string; minor: number } => x.minor !== null);
  if (kids.length === 0) { return { version: '3.0', existed: false }; }
  kids.sort((a, b) => b.minor - a.minor);
  return { version: kids[0]!.name, existed: true };
}

/**
 * The versioned GIMP config dir(s) to install into — the parent of both
 * `plug-ins/` (server) and `mcp/` (client). The first entry is the PRIMARY
 * (the real %APPDATA%/config dir); the rest are the win32 Store safety net.
 */
function resolveConfigDirs(
  opts: GimpInstallOpts | undefined,
  d: GimpInstallDeps,
): { dirs: string[]; version: string; warnings: string[] } {
  const warnings: string[] = [];
  const override = (opts?.targetDir && opts.targetDir.trim()) || (d.env.GIMP3_DIRECTORY && d.env.GIMP3_DIRECTORY.trim());
  if (override) {
    const version = path.basename(override) || 'custom';
    if (!d.fileExists(override)) {
      warnings.push(`GIMP dir ${override} does not exist yet — creating it. Launch GIMP once so it initialises its config.`);
    }
    return { dirs: [override], version, warnings };
  }
  const base = gimpConfigBase(d);
  const chosen = chooseVersion(base, d);
  if (!chosen.existed) {
    warnings.push(
      `No GIMP 3.x config dir found under ${base} — creating ${chosen.version}. ` +
      'Launch GIMP 3 at least once (so it creates its real config dir), then re-run to be sure it lands in the right place.');
  }
  const dirs = [path.join(base, chosen.version)];
  // Windows Store virtualized safety net (only when a package dir exists).
  for (const vdir of storeVirtualizedConfigDirs(chosen.version, d)) { dirs.push(vdir); }
  return { dirs, version: chosen.version, warnings };
}

/**
 * Windows Store virtualized config dir(s) for a version. Only returned when a
 * `GIMP.*` package dir actually exists under %LOCALAPPDATA%\Packages.
 */
function storeVirtualizedConfigDirs(version: string, d: GimpInstallDeps): string[] {
  if (d.platform !== 'win32') { return []; }
  const home = d.homedir();
  const localAppData = d.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const packagesDir = path.join(localAppData, 'Packages');
  const pkgs = d.listDir(packagesDir).filter((n) => /^GIMP\./i.test(n));
  return pkgs.map((pkg) =>
    path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'GIMP', version));
}

/** The server plug-in .py path for a versioned config dir. */
function serverPathFor(configDir: string): string {
  return path.join(configDir, 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
}

/** The MCP client .py path for a versioned config dir (sibling `mcp/` folder). */
export function clientPathFor(configDir: string): string {
  return path.join(configDir, 'mcp', 'gimp_mcp_client.py');
}

/** Extract the GIMP MAJOR version from a launcher path (e.g. gimp-2.10 → 2). */
export function gimpMajorFromPath(p: string | null): number | null {
  if (!p) { return null; }
  const base = p.replace(/\\/g, '/').split('/').pop() || p;
  const m = /gimp[-_]?(\d+)/i.exec(base);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Write `source` to `target`. IDEMPOTENT: if the target already holds
 * byte-identical content, skip the write (and the .bak) — but still ensure the
 * executable bit on non-Windows. A .bak backup is made ONLY when overwriting
 * content that DIFFERS from the source.
 */
function writeIdempotent(target: string, source: string, d: GimpInstallDeps): string {
  d.mkdirp(path.dirname(target));
  if (d.fileExists(target)) {
    const existing = d.readFile(target);
    if (existing === source) {
      if (d.platform !== 'win32') { d.chmod(target, 0o755); }
      return target;
    }
    d.copyFile(target, target + '.bak');
  }
  d.writeFile(target, source);
  if (d.platform !== 'win32') { d.chmod(target, 0o755); }
  return target;
}

/**
 * Gate helper: is this a GIMP we must NOT install for? (detected AND clearly < 3).
 * Returns a warning string to surface, or null when install may proceed.
 */
function refuseIfOldGimp(d: GimpInstallDeps): string | null {
  const det = d.detectGimp();
  const major = gimpMajorFromPath(det.path);
  if (det.installed && major !== null && major < 3) {
    return (
      `Detected GIMP ${major}.x at ${det.path}. GIMP MCP needs GIMP 3.x — ` +
      'the plugin uses the GIMP 3.0 Python API and was NOT installed. ' +
      'Install GIMP 3 and re-run.');
  }
  return null;
}

/**
 * Install BOTH the GIMP-side plug-in (server) and the MCP client. Resolves the
 * target config dir(s) per-OS and writes the vendored files. Does NOT install
 * when a clearly < 3 GIMP is the only one detected.
 */
export function installGimpPlugin(
  opts?: GimpInstallOpts,
  deps?: Partial<GimpInstallDeps>,
): GimpInstallResult {
  const d: GimpInstallDeps = { ...realDeps(), ...deps };
  const warnings: string[] = [];

  const refusal = refuseIfOldGimp(d);
  if (refusal) {
    warnings.push(refusal);
    return { installed: false, serverPath: null, clientPath: null, paths: [], clientPaths: [], version: null, warnings };
  }

  const serverSource = d.readPluginSource();
  const clientSource = d.readClientSource();

  const { dirs, version, warnings: resolveWarnings } = resolveConfigDirs(opts, d);
  warnings.push(...resolveWarnings);

  const paths: string[] = [];
  const clientPaths: string[] = [];
  for (const configDir of dirs) {
    try {
      paths.push(writeIdempotent(serverPathFor(configDir), serverSource, d));
    } catch (e) {
      warnings.push(`Failed to write plugin into ${configDir}: ${(e as Error).message}`);
    }
    try {
      clientPaths.push(writeIdempotent(clientPathFor(configDir), clientSource, d));
    } catch (e) {
      warnings.push(`Failed to write client into ${configDir}: ${(e as Error).message}`);
    }
  }

  return {
    installed: paths.length > 0,
    serverPath: paths[0] ?? null,
    clientPath: clientPaths[0] ?? null,
    paths,
    clientPaths,
    version,
    warnings,
  };
}

/**
 * Sync-path variant: install ONLY when GIMP 3.x is actually DETECTED. Unlike
 * installGimpPlugin (which will create a 3.0 config dir even with no GIMP present
 * — appropriate for the explicit `mcp detect --enable gimp` / `gimp-install-plugin`
 * flows), this refuses to touch the filesystem when GIMP is absent or is clearly
 * < 3, so a routine ConfigManager.syncProjectMcpServers on a box without GIMP
 * never spuriously creates a config dir. Returns a skip result (installed:false +
 * warning) instead of throwing so callers can swallow it.
 */
export function installGimpPluginIfDetected(
  opts?: GimpInstallOpts,
  deps?: Partial<GimpInstallDeps>,
): GimpInstallResult {
  const d: GimpInstallDeps = { ...realDeps(), ...deps };
  const det = d.detectGimp();
  const major = gimpMajorFromPath(det.path);
  // Require a detected GIMP that is not clearly < 3 (major null = version not in
  // the launcher path, e.g. a macOS app bundle — allowed).
  if (!det.installed || (major !== null && major < 3)) {
    return {
      installed: false,
      serverPath: null,
      clientPath: null,
      paths: [],
      clientPaths: [],
      version: null,
      warnings: ['GIMP 3.x not detected — plugin install skipped (sync path).'],
    };
  }
  return installGimpPlugin(opts, deps);
}

/**
 * Resolve the PRIMARY MCP client path for the current machine WITHOUT writing
 * anything — gated on GIMP 3.x being detected (same gate as
 * installGimpPluginIfDetected). Returns null when GIMP is absent / clearly < 3,
 * so callers (the migration, catalog display) can decide not to bake a path in.
 * This is the exact path installGimpPlugin() would write the client to.
 */
export function resolveGimpClientPath(
  opts?: GimpInstallOpts,
  deps?: Partial<GimpInstallDeps>,
): string | null {
  const d: GimpInstallDeps = { ...realDeps(), ...deps };
  const det = d.detectGimp();
  const major = gimpMajorFromPath(det.path);
  if (!det.installed || (major !== null && major < 3)) { return null; }
  const { dirs } = resolveConfigDirs(opts, d);
  const primary = dirs[0];
  return primary ? clientPathFor(primary) : null;
}
