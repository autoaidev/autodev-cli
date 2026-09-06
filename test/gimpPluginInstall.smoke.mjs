// Smoke test for the auto-start GIMP MCP plugin installer
// (src/core/gimpPluginInstall.ts). Run after `npm run build` — imports out/.
//
// Proves, with a FAKE filesystem / injected deps (no real GIMP needed):
//   (a) win32 %APPDATA%\GIMP\3.2 present → plug-ins/gimp_mcp_server/gimp_mcp_server.py
//   (b) both 3.0 and 3.2 present → picks 3.2 (highest minor; 3.10 > 3.2 too)
//   (c) linux ~/.config/GIMP/3.2 → correct path + chmod 0o755 called
//   (d) existing plugin file → backed up to .bak
//   (e) GIMP 2.10 only → not installed + warning
//   (f) GIMP3_DIRECTORY env override honored
//   (+) win32 Store virtualized fallback also written when a GIMP.* package exists
//   (+) vendored plugin file exists + is PERSISTENT + calls persistent_ready
//   (+) GPL LICENSE vendored next to it

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installGimpPlugin, gimpMajorFromPath, vendoredPluginSourcePath } from '../out/core/gimpPluginInstall.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// A recording fake-fs deps factory. `files` = paths that exist; `dirs` = dir→children.
function makeDeps(over) {
  const files = new Set(over.files || []);
  const dirs = over.dirs || {};
  const writes = [];
  const mkdirs = [];
  const chmods = [];
  const copies = [];
  const deps = {
    platform: over.platform,
    env: over.env || {},
    homedir: () => over.home,
    fileExists: (p) => files.has(p),
    listDir: (p) => dirs[p] || [],
    mkdirp: (p) => { mkdirs.push(p); },
    writeFile: (p, data) => { writes.push({ p, data }); },
    chmod: (p, mode) => { chmods.push({ p, mode }); },
    copyFile: (src, dst) => { copies.push({ src, dst }); },
    readPluginSource: () => over.source || 'PLUGIN-SOURCE',
    detectGimp: () => over.detect || { installed: false, path: null, source: null },
  };
  return { deps, writes, mkdirs, chmods, copies };
}

// ── (a) win32 %APPDATA%\GIMP\3.2 present ────────────────────────────────────
{
  const appData = 'C:\\Users\\me\\AppData\\Roaming';
  const gimpBase = path.join(appData, 'GIMP');
  const { deps, writes } = makeDeps({
    platform: 'win32', home: 'C:\\Users\\me',
    env: { APPDATA: appData },
    dirs: { [gimpBase]: ['3.2'] },
  });
  const res = installGimpPlugin(undefined, deps);
  const expected = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  ok(res.installed === true, 'win32: installed');
  ok(res.version === '3.2', 'win32: version resolves to 3.2');
  ok(res.paths.includes(expected), 'win32: path is %APPDATA%\\GIMP\\3.2\\plug-ins\\gimp_mcp_server\\gimp_mcp_server.py');
  ok(writes.some((w) => w.p === expected && w.data === 'PLUGIN-SOURCE'), 'win32: wrote the vendored source');
}

// ── (b) both 3.0 and 3.2 (and 3.10) present → picks highest minor ───────────
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.0', '3.2', '3.10', 'tmp'] },
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.version === '3.10', 'linux: picks highest minor (3.10 > 3.2 > 3.0) numerically');
}

// ── (c) linux ~/.config/GIMP/3.2 → correct path + chmod 0o755 ───────────────
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps, chmods } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
  });
  const res = installGimpPlugin(undefined, deps);
  const expected = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  ok(res.paths[0] === expected, 'linux: path under ~/.config/GIMP/3.2/plug-ins/gimp_mcp_server/');
  ok(chmods.some((c) => c.p === expected && c.mode === 0o755), 'linux: chmod 0o755 called on the .py');
  ok(res.warnings.length === 0, 'linux: no warnings when a 3.x dir exists');
}

// XDG_CONFIG_HOME override honored
{
  const home = '/home/u';
  const xdg = '/home/u/xdgcfg';
  const gimpBase = path.join(xdg, 'GIMP');
  const { deps } = makeDeps({
    platform: 'linux', home, env: { XDG_CONFIG_HOME: xdg },
    dirs: { [gimpBase]: ['3.2'] },
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.paths[0] === path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py'),
    'linux: XDG_CONFIG_HOME base honored');
}

// ── (d) existing plugin file → backed up to .bak ────────────────────────────
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const py = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  const { deps, copies } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    files: [py], // the .py already exists → must be backed up
  });
  installGimpPlugin(undefined, deps);
  ok(copies.some((c) => c.src === py && c.dst === py + '.bak'), 'existing plugin backed up to .bak');
}

// ── (e) GIMP 2.10 only → not installed + warning ────────────────────────────
{
  const home = '/home/u';
  const { deps, writes } = makeDeps({
    platform: 'linux', home, env: {},
    detect: { installed: true, path: '/usr/bin/gimp-2.10', source: 'path' },
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.installed === false, 'gimp 2.10: NOT installed');
  ok(writes.length === 0, 'gimp 2.10: nothing written');
  ok(res.warnings.some((w) => /GIMP 3\.x/i.test(w)), 'gimp 2.10: warns GIMP MCP needs GIMP 3.x');
  ok(gimpMajorFromPath('/usr/bin/gimp-2.10') === 2, 'gimpMajorFromPath parses 2 from gimp-2.10');
  ok(gimpMajorFromPath('C:\\tools\\gimp-3.2.exe') === 3, 'gimpMajorFromPath parses 3 from gimp-3.2.exe');
  ok(gimpMajorFromPath('/Applications/GIMP.app/Contents/MacOS/gimp') === null, 'gimpMajorFromPath: no version in app-bundle → null (not blocked)');
}

// GIMP 3.x detected → still installs (major gate only blocks < 3)
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: true, path: '/usr/bin/gimp-3.2', source: 'path' },
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.installed === true, 'gimp 3.2 detected → installs');
}

// ── (f) GIMP3_DIRECTORY env override honored ────────────────────────────────
{
  const home = '/home/u';
  const custom = '/opt/mygimp';
  const { deps } = makeDeps({
    platform: 'linux', home, env: { GIMP3_DIRECTORY: custom },
    files: [custom], // exists → no create warning
  });
  const res = installGimpPlugin(undefined, deps);
  const expected = path.join(custom, 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  ok(res.paths[0] === expected, 'GIMP3_DIRECTORY overrides the whole versioned dir');
}

// No 3.x dir at all → creates 3.0 + warns to launch GIMP once
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: [] },
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.version === '3.0', 'no 3.x present → defaults to 3.0');
  ok(res.warnings.some((w) => /Launch GIMP 3/i.test(w)), 'no 3.x present → warns to launch GIMP once');
}

// ── (+) win32 Store virtualized fallback when a GIMP.* package dir exists ────
{
  const home = 'C:\\Users\\me';
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const gimpBase = path.join(appData, 'GIMP');
  const packagesDir = path.join(localAppData, 'Packages');
  const pkgName = 'GIMP.GIMP_a1b2c3';
  const { deps } = makeDeps({
    platform: 'win32', home,
    env: { APPDATA: appData, LOCALAPPDATA: localAppData },
    dirs: { [gimpBase]: ['3.2'], [packagesDir]: [pkgName, 'Some.Other_x'] },
  });
  const res = installGimpPlugin(undefined, deps);
  const real = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  const virt = path.join(packagesDir, pkgName, 'LocalCache', 'Roaming', 'GIMP', '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  ok(res.paths.includes(real), 'win32 Store: real %APPDATA% path written');
  ok(res.paths.includes(virt), 'win32 Store: virtualized package path ALSO written');
  ok(res.paths.length === 2, 'win32 Store: exactly the 2 target paths');
}

// ── (+) vendored plugin file exists + PERSISTENT + persistent_ready + LICENSE ─
{
  const src = vendoredPluginSourcePath();
  ok(fs.existsSync(src), 'vendored media/gimp/gimp_mcp_server.py exists');
  const body = fs.readFileSync(src, 'utf8');
  ok(/PERSISTENT/.test(body), 'vendored plugin registers as PERSISTENT');
  ok(/persistent_ready/.test(body), 'vendored plugin calls persistent_ready');
  ok(/plug-in-mcp-server-autostart/.test(body), 'vendored plugin query proc = plug-in-mcp-server-autostart');
  ok(!/add_menu_path|set_menu_label/.test(body), 'vendored plugin adds NO menu path / label (auto-start)');
  ok(/Derived from libreearth\/gimp-mcp @49c46dd/.test(body), 'vendored plugin carries GPL provenance header');
  const lic = path.join(REPO, 'media', 'gimp', 'LICENSE');
  ok(fs.existsSync(lic) && /GNU GENERAL PUBLIC LICENSE/.test(fs.readFileSync(lic, 'utf8')), 'GPL LICENSE vendored at media/gimp/LICENSE');
}

if (failures) { console.error(`\ngimpPluginInstall.smoke: ${failures} FAILED`); process.exit(1); }
console.log('\ngimpPluginInstall.smoke: all passed');
