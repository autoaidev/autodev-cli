// ---------------------------------------------------------------------------
// binDetect — cross-platform detection of on-PATH launchers AND creative apps
// that install OUTSIDE PATH (Blender / GIMP).
//
// Everything is dependency-injected ({platform, env, homedir, fileExists}) so
// the detection logic is unit-testable without the app actually being present:
// a fake Program Files tree on win32, a PATH hit on linux, etc.
//
// We never spawn the app itself. We DO shell the OS name resolver
// (`where` on win32, `which` on unix) as the authoritative launcher probe:
// `fs.existsSync`/`statSync` FAIL on Windows execution-alias reparse stubs
// (%LOCALAPPDATA%\Microsoft\WindowsApps\*.exe are 0-byte AppExecLink
// reparse points → stat errors → existsSync returns false), so a pure
// filesystem probe cannot see a Store-installed launcher. The OS resolver can.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export interface BinDetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  /** Existence probe (stat). Injected so tests can fake a filesystem. */
  fileExists: (p: string) => boolean;
  /** List a directory's immediate children. Returns [] on any error/missing dir. */
  listDir: (p: string) => string[];
  /**
   * OS-native name resolver: shells `where <name>` (win32) / `which <name>`
   * (unix) and returns the raw stdout, or null on any failure / not-found.
   * Injected so tests can simulate `where gimp-3` → a WindowsApps alias path
   * without a real Windows box. The default impl only actually shells out when
   * the requested platform matches the real host (so cross-platform-simulated
   * unit tests stay hermetic and never touch the host PATH).
   */
  runWhich: (name: string, platform: NodeJS.Platform) => string | null;
}

function realFileExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function realListDir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

/**
 * Real OS-native resolver. Shells `where`/`which` and returns raw stdout.
 * try/catch-guarded end to end: a missing resolver or a non-zero exit
 * (not-found) throws → we return null and detection falls through.
 * Only shells out when `platform` matches the real host — a unit test that
 * *simulates* win32 on a linux CI box must inject its own runWhich; the
 * default here refuses to leak the host's PATH into a foreign-platform sim.
 */
function realRunWhich(name: string, platform: NodeJS.Platform): string | null {
  if (platform !== process.platform) { return null; }
  try {
    const isWin = process.platform === 'win32';
    const out = isWin
      ? execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true })
      : execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

export function defaultBinDetectDeps(): BinDetectDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir,
    fileExists: realFileExists,
    listDir: realListDir,
    runWhich: realRunWhich,
  };
}

function mergeDeps(deps?: Partial<BinDetectDeps>): BinDetectDeps {
  return { ...defaultBinDetectDeps(), ...(deps || {}) };
}

/** Windows executable extensions, honoring %PATHEXT% with a sane fallback. */
function winExts(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.PATHEXT || '').split(';').map((e) => e.trim()).filter(Boolean);
  const exts = raw.length ? raw : ['.EXE', '.CMD', '.BAT', '.COM'];
  // Always allow the bare name too (e.g. a launcher that already carries an ext).
  return ['', ...exts.map((e) => (e.startsWith('.') ? e : '.' + e))];
}

/**
 * Authoritative OS-native resolution of a bare launcher name via `where`/`which`.
 * Returns the first resolved absolute path (trimmed), or null. This is the only
 * probe that correctly sees Windows execution-alias reparse stubs, which
 * `fs.existsSync`/`statSync` (and therefore every fileExists-based probe) miss.
 * Never throws — runWhich is fully try/catch-guarded.
 */
function whichSyncNative(name: string, d: BinDetectDeps): string | null {
  // Only meaningful for bare names; explicit paths are probed via fileExists.
  if (/[\\/]/.test(name)) { return null; }
  let out: string | null = null;
  try { out = d.runWhich(name, d.platform); } catch { out = null; }
  if (!out) { return null; }
  const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

/** True if a resolved path lives under the Microsoft Store execution-alias dir. */
function isWindowsAppsAliasPath(p: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(p);
}

/**
 * Resolve a bare launcher name against PATH, plus a few well-known install
 * dirs that are frequently missing from a GUI-launched process's PATH
 * (~/.local/bin everywhere; %LOCALAPPDATA%\Programs and %APPDATA%\npm on win).
 * Returns the absolute path of the first match, or null.
 *
 * Order: fast manual PATH/extra-dir parse first (cheap, no spawn), then the
 * authoritative OS-native `where`/`which` resolver as a fallback — the latter
 * is what catches PATHEXT edge cases and Windows execution-alias reparse stubs
 * that fileExists cannot stat.
 */
export function detectBinOnPath(bin: string, deps?: Partial<BinDetectDeps>): string | null {
  const d = mergeDeps(deps);
  const isWin = d.platform === 'win32';

  // A caller that passes an explicit path (has a separator) just gets probed.
  if (/[\\/]/.test(bin)) {
    return d.fileExists(bin) ? bin : null;
  }

  const exts = isWin ? winExts(d.env) : [''];
  const sep = isWin ? ';' : ':';
  const pathDirs = (d.env.PATH || d.env.Path || '').split(sep).map((s) => s.trim()).filter(Boolean);

  const extraDirs: string[] = [];
  const home = d.homedir();
  if (home) { extraDirs.push(path.join(home, '.local', 'bin')); }
  if (isWin) {
    const local = d.env.LOCALAPPDATA;
    const appdata = d.env.APPDATA;
    if (local) { extraDirs.push(path.join(local, 'Programs')); }
    if (appdata) { extraDirs.push(path.join(appdata, 'npm')); }
  }

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (d.fileExists(full)) { return full; }
    }
  }

  // Authoritative fallback: OS resolver (handles reparse-stub aliases + PATHEXT).
  return whichSyncNative(bin, d);
}

// 'store' = a Microsoft Store / execution-alias install on Windows
// (%LOCALAPPDATA%\Microsoft\WindowsApps stub, or the ACL-locked
// %ProgramFiles%\WindowsApps package VFS tree).
export type AppSource = 'path' | 'program-files' | 'app-bundle' | 'flatpak' | 'snap' | 'known-dir' | 'store';

export interface DetectAppResult {
  installed: boolean;
  path: string | null;
  source: AppSource | null;
}

interface Candidate { path: string; source: AppSource; }

/** First candidate whose file exists wins (candidates are pre-ordered by preference). */
function firstExisting(cands: Candidate[], d: BinDetectDeps): DetectAppResult {
  for (const c of cands) {
    if (c.path && d.fileExists(c.path)) { return { installed: true, path: c.path, source: c.source }; }
  }
  return { installed: false, path: null, source: null };
}

/** Children of `parent` matching `re`, joined back to absolute paths (safe on missing dirs). */
function globChildren(parent: string, re: RegExp, d: BinDetectDeps): string[] {
  return d.listDir(parent).filter((n) => re.test(n)).sort().map((n) => path.join(parent, n));
}

/** Flatpak per-app exported launcher path, checked in the user + system roots. */
function flatpakExportCandidates(appId: string, d: BinDetectDeps): Candidate[] {
  const roots: string[] = [];
  const home = d.homedir();
  if (home) { roots.push(path.join(home, '.local', 'share', 'flatpak')); }
  roots.push('/var/lib/flatpak');
  return roots.map((r) => ({ path: path.join(r, 'exports', 'bin', appId), source: 'flatpak' as AppSource }));
}

/** Windows "Program Files" roots we know about (64-bit, 32-bit, and env overrides). */
function winProgramRoots(d: BinDetectDeps): string[] {
  const roots = new Set<string>();
  for (const v of [d.env.PROGRAMFILES, d.env['ProgramW6432'], d.env['ProgramFiles(x86)']]) {
    if (v) { roots.add(v); }
  }
  roots.add('C:\\Program Files');
  roots.add('C:\\Program Files (x86)');
  return [...roots];
}

/**
 * The Microsoft Store execution-alias stub dir:
 *   %LOCALAPPDATA%\Microsoft\WindowsApps
 * This dir is on the user's PATH by default and holds 0-byte alias stubs
 * (e.g. gimp-3.exe, blender.exe). A 0-byte stub still passes fileExists,
 * so finding a launcher here means the app is installed via the Store.
 */
function winAppsAliasDir(d: BinDetectDeps): string | null {
  const local = d.env.LOCALAPPDATA;
  return local ? path.join(local, 'Microsoft', 'WindowsApps') : null;
}

/**
 * Best-effort scan of the ACL-restricted %ProgramFiles%\WindowsApps store dir
 * for a packaged app's real exe, e.g.
 *   ...\GIMP.<hash>_3.2.44.0_x64__<pub>\VFS\ProgramFilesX64\GIMP\bin\gimp-3.2.exe
 * WindowsApps is ACL-locked and listing it may throw (EACCES/EPERM) — every
 * directory read is wrapped so a denial is swallowed and detection falls
 * through to the alias-stub probe. Never throws.
 */
function winStorePackageExes(pkgRe: RegExp, binLeaves: string[], exeRe: RegExp, d: BinDetectDeps): string[] {
  const out: string[] = [];
  for (const root of winProgramRoots(d)) {
    const wa = path.join(root, 'WindowsApps');
    let pkgs: string[];
    try { pkgs = d.listDir(wa).filter((n) => pkgRe.test(n)); } catch { pkgs = []; }
    for (const pkg of pkgs) {
      for (const leaf of binLeaves) {
        const binDir = leaf ? path.join(wa, pkg, ...leaf.split('/')) : path.join(wa, pkg);
        let exes: string[];
        try { exes = d.listDir(binDir).filter((n) => exeRe.test(n)); } catch { exes = []; }
        for (const exe of exes) { out.push(path.join(binDir, exe)); }
      }
    }
  }
  return out;
}

function detectBlender(d: BinDetectDeps): DetectAppResult {
  // 1) OS-native resolver FIRST — authoritative for PATH + PATHEXT + Windows
  //    execution-alias reparse stubs (which fileExists cannot stat).
  const nativ = whichSyncNative('blender', d);
  if (nativ) { return { installed: true, path: nativ, source: isWindowsAppsAliasPath(nativ) ? 'store' : 'path' }; }

  // 2) Manual PATH / off-PATH dir probe (fileExists fast path).
  const onPath = detectBinOnPath('blender', d);
  if (onPath) { return { installed: true, path: onPath, source: 'path' }; }

  const cands: Candidate[] = [];
  if (d.platform === 'win32') {
    // C:\Program Files\Blender Foundation\Blender X.Y\blender.exe
    for (const root of winProgramRoots(d)) {
      const foundation = path.join(root, 'Blender Foundation');
      for (const verDir of globChildren(foundation, /^Blender/i, d)) {
        cands.push({ path: path.join(verDir, 'blender.exe'), source: 'program-files' });
      }
    }
    // %LOCALAPPDATA%\Programs\Blender Foundation\Blender X.Y\blender.exe
    const local = d.env.LOCALAPPDATA;
    if (local) {
      const foundation = path.join(local, 'Programs', 'Blender Foundation');
      for (const verDir of globChildren(foundation, /^Blender/i, d)) {
        cands.push({ path: path.join(verDir, 'blender.exe'), source: 'program-files' });
      }
    }
    // Steam: ...\Steam\steamapps\common\Blender\blender.exe
    for (const root of winProgramRoots(d)) {
      cands.push({ path: path.join(root, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'), source: 'known-dir' });
    }
    // Microsoft Store / execution-alias stub on PATH:
    //   %LOCALAPPDATA%\Microsoft\WindowsApps\blender.exe (0-byte, but exists)
    const aliasDir = winAppsAliasDir(d);
    if (aliasDir) {
      cands.push({ path: path.join(aliasDir, 'blender.exe'), source: 'store' });
      for (const exe of globChildren(aliasDir, /^blender.*\.exe$/i, d)) {
        cands.push({ path: exe, source: 'store' });
      }
    }
    // Best-effort: ACL-restricted store package VFS tree (try/catch → swallowed).
    for (const exe of winStorePackageExes(/Blender/i, ['', 'VFS/ProgramFilesX64/Blender'], /^blender\.exe$/i, d)) {
      cands.push({ path: exe, source: 'store' });
    }
  } else if (d.platform === 'darwin') {
    cands.push({ path: '/Applications/Blender.app/Contents/MacOS/Blender', source: 'app-bundle' });
    const home = d.homedir();
    if (home) { cands.push({ path: path.join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'), source: 'app-bundle' }); }
  } else {
    cands.push({ path: '/usr/bin/blender', source: 'known-dir' });
    cands.push({ path: '/usr/local/bin/blender', source: 'known-dir' });
    cands.push({ path: '/snap/bin/blender', source: 'snap' });
    cands.push(...flatpakExportCandidates('org.blender.Blender', d));
  }
  return firstExisting(cands, d);
}

function detectGimp(d: BinDetectDeps): DetectAppResult {
  // Newest-first. Includes GIMP 3.x versioned launcher names used by the
  // Microsoft Store / CLI execution aliases (gimp-3, gimp-3.2, …).
  const binNames = ['gimp-3.2', 'gimp-3.1', 'gimp-3.0', 'gimp-3', 'gimp-2.99', 'gimp-2.10', 'gimp'];
  // 1) OS-native resolver FIRST — authoritative for PATH + PATHEXT + Windows
  //    execution-alias reparse stubs (0-byte AppExecLink stubs that
  //    fileExists/statSync cannot see). A hit under \Microsoft\WindowsApps\
  //    is a Store/execution-alias install → source 'store', else 'path'.
  for (const b of binNames) {
    const nativ = whichSyncNative(b, d);
    if (nativ) { return { installed: true, path: nativ, source: isWindowsAppsAliasPath(nativ) ? 'store' : 'path' }; }
  }
  // 2) Manual PATH / off-PATH dir probe (fileExists fast path).
  for (const b of binNames) {
    const onPath = detectBinOnPath(b, d);
    if (onPath) { return { installed: true, path: onPath, source: 'path' }; }
  }

  const cands: Candidate[] = [];
  if (d.platform === 'win32') {
    // Microsoft Store / execution-alias stub on PATH (0-byte, but exists):
    //   %LOCALAPPDATA%\Microsoft\WindowsApps\gimp-3.exe
    const aliasDir = winAppsAliasDir(d);
    if (aliasDir) {
      for (const b of binNames) {
        cands.push({ path: path.join(aliasDir, b + '.exe'), source: 'store' });
      }
      // Anything shaped like gimp-*.exe that we can glob in that dir.
      for (const exe of globChildren(aliasDir, /^gimp.*\.exe$/i, d)) {
        cands.push({ path: exe, source: 'store' });
      }
    }
    // C:\Program Files\GIMP 2\bin\gimp-2.10.exe  (version dirs + version'd exe)
    for (const root of winProgramRoots(d)) {
      for (const gimpDir of globChildren(root, /^GIMP/i, d)) {
        const bin = path.join(gimpDir, 'bin');
        for (const exe of globChildren(bin, /^gimp.*\.exe$/i, d)) {
          cands.push({ path: exe, source: 'program-files' });
        }
      }
    }
    // Best-effort: ACL-restricted store package VFS tree, e.g.
    //   ...\GIMP.<hash>_..._x64__<pub>\VFS\ProgramFilesX64\GIMP\bin\gimp-3.2.exe
    // (try/catch inside → EACCES/EPERM on the locked dir is swallowed).
    for (const exe of winStorePackageExes(/^GIMP/i, ['VFS/ProgramFilesX64/GIMP/bin'], /^gimp.*\.exe$/i, d)) {
      cands.push({ path: exe, source: 'store' });
    }
  } else if (d.platform === 'darwin') {
    cands.push({ path: '/Applications/GIMP.app/Contents/MacOS/gimp', source: 'app-bundle' });
    cands.push({ path: '/Applications/GIMP.app/Contents/MacOS/GIMP', source: 'app-bundle' });
    // Versioned bundle naming (GIMP-2.10.app).
    for (const appDir of globChildren('/Applications', /^GIMP[-.].*\.app$/i, d)) {
      cands.push({ path: path.join(appDir, 'Contents', 'MacOS', 'gimp'), source: 'app-bundle' });
      cands.push({ path: path.join(appDir, 'Contents', 'MacOS', 'GIMP'), source: 'app-bundle' });
    }
  } else {
    for (const b of binNames) {
      cands.push({ path: `/usr/bin/${b}`, source: 'known-dir' });
      cands.push({ path: `/usr/local/bin/${b}`, source: 'known-dir' });
    }
    cands.push({ path: '/snap/bin/gimp', source: 'snap' });
    cands.push(...flatpakExportCandidates('org.gimp.GIMP', d));
  }
  return firstExisting(cands, d);
}

/**
 * Detect a known creative app across PATH + platform default install locations.
 * Never throws; never spawns the app.
 */
export function detectApp(app: 'blender' | 'gimp', deps?: Partial<BinDetectDeps>): DetectAppResult {
  const d = mergeDeps(deps);
  return app === 'blender' ? detectBlender(d) : detectGimp(d);
}
