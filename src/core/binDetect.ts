// ---------------------------------------------------------------------------
// binDetect — cross-platform detection of on-PATH launchers AND creative apps
// that install OUTSIDE PATH (Blender / GIMP).
//
// Everything is dependency-injected ({platform, env, homedir, fileExists}) so
// the detection logic is unit-testable without the app actually being present:
// a fake Program Files tree on win32, a PATH hit on linux, etc.
//
// We only ever stat / glob directories and read PATH — we never spawn the app.
// (Node fs/path/os only; no child_process here.)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BinDetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  /** Existence probe (stat). Injected so tests can fake a filesystem. */
  fileExists: (p: string) => boolean;
  /** List a directory's immediate children. Returns [] on any error/missing dir. */
  listDir: (p: string) => string[];
}

function realFileExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function realListDir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

export function defaultBinDetectDeps(): BinDetectDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir,
    fileExists: realFileExists,
    listDir: realListDir,
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
 * Resolve a bare launcher name against PATH, plus a few well-known install
 * dirs that are frequently missing from a GUI-launched process's PATH
 * (~/.local/bin everywhere; %LOCALAPPDATA%\Programs and %APPDATA%\npm on win).
 * Returns the absolute path of the first match, or null.
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
  return null;
}

export type AppSource = 'path' | 'program-files' | 'app-bundle' | 'flatpak' | 'snap' | 'known-dir';

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

function detectBlender(d: BinDetectDeps): DetectAppResult {
  // 1) PATH (all platforms) — highest confidence.
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
  const binNames = ['gimp', 'gimp-3.0', 'gimp-2.99', 'gimp-2.10'];
  // 1) PATH (all platforms).
  for (const b of binNames) {
    const onPath = detectBinOnPath(b, d);
    if (onPath) { return { installed: true, path: onPath, source: 'path' }; }
  }

  const cands: Candidate[] = [];
  if (d.platform === 'win32') {
    // C:\Program Files\GIMP 2\bin\gimp-2.10.exe  (version dirs + version'd exe)
    for (const root of winProgramRoots(d)) {
      for (const gimpDir of globChildren(root, /^GIMP/i, d)) {
        const bin = path.join(gimpDir, 'bin');
        for (const exe of globChildren(bin, /^gimp.*\.exe$/i, d)) {
          cands.push({ path: exe, source: 'program-files' });
        }
      }
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
