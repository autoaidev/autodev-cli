// ---------------------------------------------------------------------------
// gimpPluginInstall — drop the vendored AUTO-START GIMP MCP plugin into the
// correct GIMP 3.x user plug-ins folder so the socket bridge opens on GIMP
// launch (no manual copy, no menu click).
//
// GROUNDED RULES (see AutoDev research):
//  - GIMP 3.x user config is MINOR-versioned: GIMP 3.2 → .../GIMP/3.2/ (NOT 3.0).
//    Bases: linux $XDG_CONFIG_HOME/GIMP or ~/.config/GIMP; win32 %APPDATA%\GIMP;
//    darwin ~/Library/Application Support/GIMP. Honor GIMP3_DIRECTORY (overrides
//    the WHOLE versioned dir). Glob GIMP/3.* and pick the HIGHEST minor; if none
//    exists, create 3.0 and warn (user should launch GIMP once).
//  - GIMP 3.x layout: plug-ins/gimp_mcp_server/gimp_mcp_server.py — the .py MUST
//    sit in a sub-folder whose name == the .py basename (a loose .py is ignored).
//    On non-Windows the .py must be executable (0o755).
//  - Windows Store (MSIX) GIMP reads the REAL %APPDATA%\GIMP\<ver>. As a safety
//    net we ALSO write the virtualized path when a package dir exists:
//    %LOCALAPPDATA%\Packages\GIMP.<...>_*\LocalCache\Roaming\GIMP\<ver>\plug-ins.
//
// Everything is dependency-injected (platform/env/homedir/fileExists/listDir/
// mkdirp/writeFile/chmod/copyFile/readPluginSource/detectGimp) so the resolver is
// unit-testable without a real GIMP or filesystem.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectApp, type DetectAppResult } from './binDetect';

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
  /** The vendored auto-start plugin source (media/gimp/gimp_mcp_server.py). */
  readPluginSource: () => string;
  /** GIMP detection (to gate on major < 3). Defaults to detectApp('gimp'). */
  detectGimp: () => DetectAppResult;
}

export interface GimpInstallResult {
  installed: boolean;
  /** Absolute path(s) of the written gimp_mcp_server.py file(s). */
  paths: string[];
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

/** Absolute path to the vendored auto-start plugin shipped in the tarball. */
export function vendoredPluginSourcePath(): string {
  // Compiled to out/core/gimpPluginInstall.js → package root is ../../ .
  return path.join(__dirname, '..', '..', 'media', 'gimp', 'gimp_mcp_server.py');
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
    readPluginSource: () => fs.readFileSync(vendoredPluginSourcePath(), 'utf8'),
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
 * Windows Store virtualized fallback plug-ins dir(s) for a given version. Only
 * returned when a `GIMP.*` package dir actually exists under %LOCALAPPDATA%\Packages.
 */
function storeVirtualizedPluginDirs(version: string, d: GimpInstallDeps): string[] {
  if (d.platform !== 'win32') { return []; }
  const home = d.homedir();
  const localAppData = d.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const packagesDir = path.join(localAppData, 'Packages');
  const pkgs = d.listDir(packagesDir).filter((n) => /^GIMP\./i.test(n));
  return pkgs.map((pkg) =>
    path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'GIMP', version, 'plug-ins'));
}

/** Extract the GIMP MAJOR version from a launcher path (e.g. gimp-2.10 → 2). */
export function gimpMajorFromPath(p: string | null): number | null {
  if (!p) { return null; }
  const base = p.replace(/\\/g, '/').split('/').pop() || p;
  const m = /gimp[-_]?(\d+)/i.exec(base);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Write the vendored plugin into one plug-ins dir (backing up any existing copy). */
function installInto(pluginsDir: string, source: string, d: GimpInstallDeps): string {
  const sub = path.join(pluginsDir, 'gimp_mcp_server');
  const py = path.join(sub, 'gimp_mcp_server.py');
  d.mkdirp(sub);
  if (d.fileExists(py)) { d.copyFile(py, py + '.bak'); }
  d.writeFile(py, source);
  if (d.platform !== 'win32') { d.chmod(py, 0o755); }
  return py;
}

/**
 * Install the auto-start GIMP MCP plugin. Resolves the target plug-ins dir(s)
 * per-OS and writes the vendored plugin so GIMP opens the localhost:9876 socket
 * on launch. Does NOT install when a clearly < 3 GIMP is the only one detected.
 */
export function installGimpPlugin(
  opts?: GimpInstallOpts,
  deps?: Partial<GimpInstallDeps>,
): GimpInstallResult {
  const d: GimpInstallDeps = { ...realDeps(), ...deps };
  const warnings: string[] = [];

  // Gate: if a GIMP is detected and is clearly < 3, do not install.
  const det = d.detectGimp();
  const major = gimpMajorFromPath(det.path);
  if (det.installed && major !== null && major < 3) {
    warnings.push(
      `Detected GIMP ${major}.x at ${det.path}. GIMP MCP needs GIMP 3.x — ` +
      'the auto-start plugin uses the GIMP 3.0 Python API and was NOT installed. ' +
      'Install GIMP 3 and re-run.');
    return { installed: false, paths: [], version: null, warnings };
  }

  const source = d.readPluginSource();

  // Resolve the versioned config dir(s). GIMP3_DIRECTORY / opts.targetDir
  // override the WHOLE versioned dir.
  const override = (opts?.targetDir && opts.targetDir.trim()) || (d.env.GIMP3_DIRECTORY && d.env.GIMP3_DIRECTORY.trim());
  const targets: string[] = [];
  let version: string;

  if (override) {
    version = path.basename(override) || 'custom';
    if (!d.fileExists(override)) {
      warnings.push(`GIMP dir ${override} does not exist yet — creating it. Launch GIMP once so it initialises its config.`);
    }
    targets.push(path.join(override, 'plug-ins'));
  } else {
    const base = gimpConfigBase(d);
    const chosen = chooseVersion(base, d);
    version = chosen.version;
    if (!chosen.existed) {
      warnings.push(
        `No GIMP 3.x config dir found under ${base} — creating ${version}. ` +
        'Launch GIMP 3 at least once (so it creates its real config dir), then re-run to be sure it lands in the right place.');
    }
    targets.push(path.join(base, version, 'plug-ins'));
    // Windows Store virtualized safety net (only when a package dir exists).
    for (const vdir of storeVirtualizedPluginDirs(version, d)) { targets.push(vdir); }
  }

  const paths: string[] = [];
  for (const pluginsDir of targets) {
    try {
      paths.push(installInto(pluginsDir, source, d));
    } catch (e) {
      warnings.push(`Failed to write plugin into ${pluginsDir}: ${(e as Error).message}`);
    }
  }

  return { installed: paths.length > 0, paths, version, warnings };
}
