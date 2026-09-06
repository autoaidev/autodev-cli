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
//   (+) vendored files: menu-triggered plugin (server) + fixed client + LICENSE
//   (+) install writes BOTH server (plug-ins/) and client (mcp/) from embedded src

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { installGimpPlugin, installGimpPluginIfDetected, gimpMajorFromPath, vendoredPluginSourcePath, vendoredClientSourcePath, clientPathFor, resolveGimpClientPath } from '../out/core/gimpPluginInstall.js';
import { GIMP_PLUGIN_SOURCE, GIMP_PLUGIN_SOURCE_HASH } from '../out/core/gimpPluginSource.js';
import { GIMP_CLIENT_SOURCE, GIMP_CLIENT_SOURCE_HASH } from '../out/core/gimpClientSource.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// A recording fake-fs deps factory. `files` = paths that exist; `dirs` = dir→children.
function makeDeps(over) {
  const files = new Set(over.files || []);
  const dirs = over.dirs || {};
  const contents = over.contents || {}; // path -> existing file content (for idempotency)
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
    readFile: (p) => (Object.prototype.hasOwnProperty.call(contents, p) ? contents[p] : ''),
    readPluginSource: () => over.source || 'PLUGIN-SOURCE',
    readClientSource: () => over.clientSource || 'CLIENT-SOURCE',
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
  const expClient = path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py');
  ok(res.installed === true, 'win32: installed');
  ok(res.version === '3.2', 'win32: version resolves to 3.2');
  ok(res.paths.includes(expected), 'win32: server path is %APPDATA%\\GIMP\\3.2\\plug-ins\\gimp_mcp_server\\gimp_mcp_server.py');
  ok(res.serverPath === expected, 'win32: serverPath = primary plug-in path');
  ok(res.clientPath === expClient, 'win32: clientPath is %APPDATA%\\GIMP\\3.2\\mcp\\gimp_mcp_client.py');
  ok(res.clientPaths.includes(expClient), 'win32: client path recorded');
  ok(writes.some((w) => w.p === expected && w.data === 'PLUGIN-SOURCE'), 'win32: wrote the vendored server source');
  ok(writes.some((w) => w.p === expClient && w.data === 'CLIENT-SOURCE'), 'win32: wrote the vendored client source');
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
  const expClient = path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py');
  ok(res.paths[0] === expected, 'linux: server path under ~/.config/GIMP/3.2/plug-ins/gimp_mcp_server/');
  ok(res.clientPath === expClient, 'linux: client path under ~/.config/GIMP/3.2/mcp/');
  ok(chmods.some((c) => c.p === expected && c.mode === 0o755), 'linux: chmod 0o755 called on the server .py');
  ok(chmods.some((c) => c.p === expClient && c.mode === 0o755), 'linux: chmod 0o755 called on the client .py');
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
  const realClient = path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py');
  const virtClient = path.join(packagesDir, pkgName, 'LocalCache', 'Roaming', 'GIMP', '3.2', 'mcp', 'gimp_mcp_client.py');
  ok(res.paths.includes(real), 'win32 Store: real %APPDATA% server path written');
  ok(res.paths.includes(virt), 'win32 Store: virtualized package server path ALSO written');
  ok(res.paths.length === 2, 'win32 Store: exactly the 2 server target paths');
  ok(res.clientPaths.includes(realClient) && res.clientPaths.includes(virtClient) && res.clientPaths.length === 2,
    'win32 Store: client mirrored to both the real and virtualized mcp/ dirs');
  ok(res.serverPath === real && res.clientPath === realClient, 'win32 Store: primary paths = the real %APPDATA% ones');
}

// ── (+) vendored files: user-verified MENU-TRIGGERED plugin + client + LICENSE ─
{
  const src = vendoredPluginSourcePath();
  ok(fs.existsSync(src), 'vendored media/gimp/gimp_mcp_server.py exists');
  const body = fs.readFileSync(src, 'utf8');
  // The user's verified plug-in is MENU-TRIGGERED (PDBProcType.PLUGIN), NOT the
  // failed PERSISTENT/auto-start variant we removed.
  ok(/PDBProcType\.PLUGIN/.test(body), 'vendored plugin registers as a PLUGIN (menu-triggered)');
  ok(/do_set_i18n/.test(body), 'vendored plugin defines do_set_i18n (required to register on 3.2)');
  ok(/ProcedureSensitivityMask\.ALWAYS/.test(body), 'vendored plugin sets ALWAYS sensitivity (enabled with no image open)');
  ok(/GLib\.MainLoop\(\)/.test(body), 'vendored plugin uses GLib.MainLoop() to keep the process alive');
  ok(/add_menu_path\('<Image>\/Tools\/MCP'\)/.test(body), 'vendored plugin adds the Tools/MCP menu path');
  ok(/Filters\/Development/.test(body), 'vendored plugin adds the Filters/Development menu path');
  ok(/'plug-in-mcp-server'/.test(body), 'vendored plugin query proc = plug-in-mcp-server');
  ok(/'list_images': 'get_images'/.test(body), 'vendored plugin maps list_images→get_images');
  ok(!/PERSISTENT|persistent_ready/.test(body), 'vendored plugin is NOT the removed PERSISTENT/auto-start variant');
  ok(/Derived from libreearth\/gimp-mcp/.test(body), 'vendored plugin carries GPL provenance header');

  const csrc = vendoredClientSourcePath();
  ok(fs.existsSync(csrc), 'vendored media/gimp/gimp_mcp_client.py exists');
  const cbody = fs.readFileSync(csrc, 'utf8');
  ok(/getpeername/.test(cbody), 'vendored client reconnects via getpeername');
  ok(/recv\(65536\)/.test(cbody), 'vendored client reads > 1024 bytes');
  ok(/Gimp\.get_images/.test(cbody), 'vendored client uses get_images');
  ok(/Derived from libreearth\/gimp-mcp/.test(cbody), 'vendored client carries GPL provenance header');

  const lic = path.join(REPO, 'media', 'gimp', 'LICENSE');
  ok(fs.existsSync(lic) && /GNU GENERAL PUBLIC LICENSE/.test(fs.readFileSync(lic, 'utf8')), 'GPL LICENSE vendored at media/gimp/LICENSE');
}

// ── (+) EMBEDDED sources: install writes GIMP_PLUGIN_SOURCE + GIMP_CLIENT_SOURCE ─
// Do NOT override readPluginSource/readClientSource → the real embedded strings.
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const py = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  const clientPy = path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py');
  const writes = [];
  const chmods = [];
  const deps = {
    platform: 'linux', env: {}, homedir: () => home,
    fileExists: () => false,
    listDir: (p) => (p === gimpBase ? ['3.2'] : []),
    mkdirp: () => {},
    writeFile: (p, data) => { writes.push({ p, data }); },
    chmod: (p, mode) => { chmods.push({ p, mode }); },
    copyFile: () => {},
    readFile: () => '',
    detectGimp: () => ({ installed: false, path: null, source: null }),
    // readPluginSource/readClientSource omitted → embedded strings used.
  };
  const res = installGimpPlugin(undefined, deps);
  ok(res.installed === true, 'embedded: installs');
  ok(writes.length === 2, 'embedded: wrote exactly 2 files (server + client)');
  ok(writes.some((w) => w.p === py && w.data === GIMP_PLUGIN_SOURCE), 'embedded: server === GIMP_PLUGIN_SOURCE');
  ok(writes.some((w) => w.p === clientPy && w.data === GIMP_CLIENT_SOURCE), 'embedded: client === GIMP_CLIENT_SOURCE');
  ok(/PDBProcType\.PLUGIN/.test(GIMP_PLUGIN_SOURCE), 'embedded: server source is the menu-triggered plugin');
  ok(/getpeername/.test(GIMP_CLIENT_SOURCE), 'embedded: client source is the fixed reconnecting client');
  ok(chmods.some((c) => c.p === py && c.mode === 0o755), 'embedded: chmod 0o755 on the server .py');
  ok(chmods.some((c) => c.p === clientPy && c.mode === 0o755), 'embedded: chmod 0o755 on the client .py');
  ok(typeof GIMP_PLUGIN_SOURCE_HASH === 'string' && GIMP_PLUGIN_SOURCE_HASH.length === 12, 'embedded: server exposes a 12-hex content hash');
  ok(typeof GIMP_CLIENT_SOURCE_HASH === 'string' && GIMP_CLIENT_SOURCE_HASH.length === 12, 'embedded: client exposes a 12-hex content hash');
}

// ── (+) IDEMPOTENT: identical existing content → skip write, no .bak ─────────
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const py = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  const clientPy = path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py');
  const { deps, writes, copies, chmods } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    files: [py, clientPy],                                         // both already exist…
    contents: { [py]: 'PLUGIN-SOURCE', [clientPy]: 'CLIENT-SOURCE' }, // …byte-identical
    source: 'PLUGIN-SOURCE', clientSource: 'CLIENT-SOURCE',
  });
  const res = installGimpPlugin(undefined, deps);
  ok(res.installed === true, 'idempotent: reports installed (path present)');
  ok(res.serverPath === py && res.clientPath === clientPy, 'idempotent: returns the target paths');
  ok(writes.length === 0, 'idempotent: NO write when both files are identical');
  ok(copies.length === 0, 'idempotent: NO .bak when content is identical');
  ok(chmods.some((c) => c.p === py && c.mode === 0o755), 'idempotent: still ensures chmod 0o755 (server)');
  ok(chmods.some((c) => c.p === clientPy && c.mode === 0o755), 'idempotent: still ensures chmod 0o755 (client)');
}

// ── (+) gen script output matches the media .py (both files) ─────────────────
{
  const py = fs.readFileSync(vendoredPluginSourcePath(), 'utf8');
  ok(GIMP_PLUGIN_SOURCE === py, 'gen: GIMP_PLUGIN_SOURCE === media/gimp/gimp_mcp_server.py (in sync)');
  ok(GIMP_PLUGIN_SOURCE_HASH === createHash('sha256').update(py, 'utf8').digest('hex').slice(0, 12),
    'gen: GIMP_PLUGIN_SOURCE_HASH matches sha256(server .py)');
  const cpy = fs.readFileSync(vendoredClientSourcePath(), 'utf8');
  ok(GIMP_CLIENT_SOURCE === cpy, 'gen: GIMP_CLIENT_SOURCE === media/gimp/gimp_mcp_client.py (in sync)');
  ok(GIMP_CLIENT_SOURCE_HASH === createHash('sha256').update(cpy, 'utf8').digest('hex').slice(0, 12),
    'gen: GIMP_CLIENT_SOURCE_HASH matches sha256(client .py)');
}

// ── (+) resolveGimpClientPath: pure resolver gated on detection ──────────────
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: true, path: '/usr/bin/gimp-3.2', source: 'path' },
  });
  const p = resolveGimpClientPath(undefined, deps);
  ok(p === path.join(gimpBase, '3.2', 'mcp', 'gimp_mcp_client.py'), 'resolveGimpClientPath: returns the primary client path when GIMP 3.x detected');
  const { deps: deps2 } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: false, path: null, source: null },
  });
  ok(resolveGimpClientPath(undefined, deps2) === null, 'resolveGimpClientPath: null when GIMP absent (no path baked in)');
}

// ── (+) SYNC path: installGimpPluginIfDetected gates on GIMP 3.x detection ───
// GIMP 3.x detected → installs to the resolved 3.x dir (what sync invokes).
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps, writes } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: true, path: '/usr/bin/gimp-3.2', source: 'path' },
    source: 'PLUGIN-SOURCE',
  });
  const res = installGimpPluginIfDetected(undefined, deps);
  const expected = path.join(gimpBase, '3.2', 'plug-ins', 'gimp_mcp_server', 'gimp_mcp_server.py');
  ok(res.installed === true, 'sync: GIMP 3.x detected → installed');
  ok(res.paths[0] === expected, 'sync: installs into the resolved 3.x plug-ins dir');
  ok(writes.some((w) => w.p === expected), 'sync: wrote the plugin');
}
// GIMP absent → NOT installed, nothing written, no throw.
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps, writes, mkdirs } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: false, path: null, source: null },
    source: 'PLUGIN-SOURCE',
  });
  const res = installGimpPluginIfDetected(undefined, deps);
  ok(res.installed === false, 'sync: GIMP absent → NOT installed');
  ok(writes.length === 0 && mkdirs.length === 0, 'sync: GIMP absent → filesystem untouched');
  ok(res.warnings.some((w) => /not detected/i.test(w)), 'sync: GIMP absent → skip warning (no throw)');
}
// GIMP < 3 → NOT installed.
{
  const home = '/home/u';
  const gimpBase = path.join(home, '.config', 'GIMP');
  const { deps, writes } = makeDeps({
    platform: 'linux', home, env: {},
    dirs: { [gimpBase]: ['3.2'] },
    detect: { installed: true, path: '/usr/bin/gimp-2.10', source: 'path' },
    source: 'PLUGIN-SOURCE',
  });
  const res = installGimpPluginIfDetected(undefined, deps);
  ok(res.installed === false, 'sync: GIMP 2.10 → NOT installed');
  ok(writes.length === 0, 'sync: GIMP 2.10 → nothing written');
}

// ── (+) SYNC integration: gimp ENABLED in .mcp.json → sync must NOT throw ────
// On a box without GIMP the plugin is not installed, but sync must still succeed
// (the whole call is guarded). Proves the wiring in ConfigManager.syncProjectMcpServers.
{
  const os = await import('os');
  const { ConfigManager } = await import('../out/configManager.js');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-gimp-sync-')));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      gimp: { command: 'uvx', args: ['--from', 'git+https://example/gimp-mcp', 'gimp-mcp'], enabled: true, _meta: { kind: 'user' } },
    },
  }, null, 2));
  let threw = null;
  try { ConfigManager.syncProjectMcpServers(dir); } catch (e) { threw = e; }
  ok(threw === null, 'sync: gimp ENABLED + no GIMP on box → sync completes without throwing');
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  const srv = after.mcpServers ?? after.servers ?? {};
  ok(!!srv['gimp'], 'sync: gimp entry preserved in .mcp.json');

  // gimp DISABLED → sync still succeeds (and obviously installs nothing).
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      gimp: { command: 'uvx', args: ['gimp-mcp'], enabled: false, _meta: { kind: 'user' } },
    },
  }, null, 2));
  let threw2 = null;
  try { ConfigManager.syncProjectMcpServers(dir); } catch (e) { threw2 = e; }
  ok(threw2 === null, 'sync: gimp DISABLED → sync completes without throwing');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) { console.error(`\ngimpPluginInstall.smoke: ${failures} FAILED`); process.exit(1); }
console.log('\ngimpPluginInstall.smoke: all passed');
