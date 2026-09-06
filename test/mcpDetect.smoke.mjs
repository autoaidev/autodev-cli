// Smoke test for creative-app MCP detection (src/core/binDetect.ts,
// src/core/mcpCatalog.ts, src/commands/mcp.ts:buildDetect). Run after
// `npm run build` — imports the compiled JS from out/.
//
// Proves, with a FAKE filesystem / injected deps (no real Blender/GIMP needed):
//   (a) detectBinOnPath honors %PATHEXT% + Program Files-style dirs on win32
//   (b) detectApp('blender') finds a fake Program Files\Blender Foundation\… tree
//   (c) detectApp('gimp') finds a PATH hit on linux; not-installed → installed:false
//   (d) serverSpecFor is platform-aware (uvx vs cmd /c uvx); gimp stub is disabled
//   (e) buildDetect emits the stable shape (blender experimental:false w/ uvx
//       server; gimp experimental:true) and a clean JSON schema

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectBinOnPath, detectApp } from '../out/core/binDetect.js';
import { serverSpecFor, getCatalog, GIMP_CLIENT_PLACEHOLDER } from '../out/core/mcpCatalog.js';
import { buildDetect } from '../out/commands/mcp.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

// A fake filesystem: a set of paths that "exist" and a dir→children map.
function makeFs(files, dirs) {
  const fileSet = new Set(files);
  const dirMap = dirs || {};
  return {
    fileExists: (p) => fileSet.has(p),
    listDir: (p) => dirMap[p] || [],
  };
}

// ── (a) detectBinOnPath: %PATHEXT% on win32 ────────────────────────────────
// NOTE: the code uses node's `path.join`, so on a posix CI host win32-simulated
// paths come out with `/` separators. We build every expectation with the same
// `path.join` so the assertions hold on any host — the PATHEXT/extra-dir LOGIC
// (not the literal separator) is what's under test.
{
  const toolDir = 'C:\\tools';
  const uvxPath = path.join(toolDir, 'uvx.EXE');
  const winFs = makeFs([uvxPath]);
  const found = detectBinOnPath('uvx', {
    platform: 'win32',
    env: { PATH: toolDir, PATHEXT: '.COM;.EXE;.BAT' },
    homedir: () => 'C:\\Users\\me',
    ...winFs,
  });
  ok(found === uvxPath, 'win32 detectBinOnPath resolves via PATHEXT (.EXE)');

  const miss = detectBinOnPath('nope', {
    platform: 'win32', env: { PATH: toolDir, PATHEXT: '.EXE' },
    homedir: () => 'C:\\Users\\me', ...winFs,
  });
  ok(miss === null, 'win32 detectBinOnPath returns null when absent');

  // Extra dir probing: %LOCALAPPDATA%\Programs even when not on PATH.
  const localAppData = 'C:\\Users\\me\\AppData\\Local';
  const thingPath = path.join(localAppData, 'Programs', 'thing.CMD');
  const extraFs = makeFs([thingPath]);
  const extra = detectBinOnPath('thing', {
    platform: 'win32',
    env: { PATH: 'C:\\nothing', PATHEXT: '.CMD', LOCALAPPDATA: localAppData },
    homedir: () => 'C:\\Users\\me', ...extraFs,
  });
  ok(extra === thingPath, 'win32 probes %LOCALAPPDATA%\\Programs off-PATH');
}

// linux PATH hit + ~/.local/bin
{
  const linFs = makeFs(['/home/u/.local/bin/uvx']);
  const found = detectBinOnPath('uvx', {
    platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', ...linFs,
  });
  ok(found === '/home/u/.local/bin/uvx', 'linux detectBinOnPath probes ~/.local/bin off-PATH');
}

// ── (b) detectApp blender: fake Program Files tree on win32 ─────────────────
{
  const pf = 'C:\\Program Files';
  const foundation = path.join(pf, 'Blender Foundation');
  const verDir = path.join(foundation, 'Blender 4.1');
  const exe = path.join(verDir, 'blender.exe');
  const winFs = makeFs([exe], { [foundation]: ['Blender 4.1'] });
  const res = detectApp('blender', {
    platform: 'win32', env: { PROGRAMFILES: pf },
    homedir: () => 'C:\\Users\\me', ...winFs,
  });
  ok(res.installed === true, 'blender detected via Program Files glob (win32)');
  ok(res.path === exe, 'blender path is the versioned blender.exe');
  ok(res.source === 'program-files', 'blender source = program-files');
}

// blender NOT installed → installed:false
{
  const emptyFs = makeFs([]);
  const res = detectApp('blender', {
    platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', ...emptyFs,
  });
  ok(res.installed === false && res.path === null && res.source === null, 'blender not-installed → false/null/null');
}

// ── (c) detectApp gimp: PATH hit on linux; and app-bundle on mac ────────────
{
  const linFs = makeFs(['/usr/bin/gimp-2.10']);
  const res = detectApp('gimp', {
    platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', ...linFs,
  });
  ok(res.installed === true && res.source === 'path', 'gimp detected on PATH (gimp-2.10, linux)');

  const macFs = makeFs(['/Applications/GIMP.app/Contents/MacOS/gimp']);
  const macRes = detectApp('gimp', {
    platform: 'darwin', env: { PATH: '/usr/bin' }, homedir: () => '/Users/u', ...macFs,
  });
  ok(macRes.installed === true && macRes.source === 'app-bundle', 'gimp detected via /Applications bundle (mac)');
}

// ── (d) serverSpecFor platform-awareness + gimp stub ────────────────────────
{
  const LAB_FROM = 'git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp';
  const bLinux = serverSpecFor('blender', 'linux');
  ok(bLinux.command === 'uvx' &&
     JSON.stringify(bLinux.args) === JSON.stringify(['--from', LAB_FROM, '--with', 'mcp<2', 'blender-mcp']),
    'blender server (non-win) = uvx --from git+…lab… --with "mcp<2" blender-mcp (official Lab client)');
  const bWin = serverSpecFor('blender', 'win32');
  ok(bWin.command === 'cmd' &&
     JSON.stringify(bWin.args) === JSON.stringify(['/c', 'uvx', '--from', LAB_FROM, '--with', 'mcp<2', 'blender-mcp']),
    'blender server (win32) = cmd /c uvx --from git+…lab… --with "mcp<2" blender-mcp');

  const gStub = serverSpecFor('gimp', 'linux');
  ok(gStub.enabled === false && gStub.args[0] === GIMP_CLIENT_PLACEHOLDER,
    'gimp stub is enabled:false with placeholder client path');
  const gReal = serverSpecFor('gimp', 'linux', { gimpClientPath: '/opt/gimp-mcp/client.py' });
  ok(gReal.enabled === undefined && gReal.args[0] === '/opt/gimp-mcp/client.py',
    'gimp with real client path is not stubbed/disabled');
}

// ── (e) buildDetect stable shape ────────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-detect-'));
  // Inject linux deps with nothing installed so the shape is deterministic.
  const emptyFs = makeFs([]);
  const result = buildDetect(root, {
    platform: 'linux', env: { PATH: '/nowhere' }, homedir: () => '/home/u', ...emptyFs,
  });
  ok(Array.isArray(result.apps) && result.apps.length === 2, 'buildDetect returns 2 apps');

  const blender = result.apps.find((a) => a.id === 'blender');
  const gimp = result.apps.find((a) => a.id === 'gimp');
  ok(blender && blender.experimental === false, 'blender experimental:false');
  ok(gimp && gimp.experimental === true, 'gimp experimental:true');
  ok(blender.serverName === 'blender' && blender.server.command === 'uvx', 'blender server spec = uvx');
  const prereqIds = blender.prerequisites.map((p) => p.id);
  ok(prereqIds.includes('uvx') && prereqIds.includes('git'),
    'blender prerequisites include BOTH uvx AND git (Lab client clones a git repo)');
  ok(blender.prerequisites.every((p) => p.installed === false), 'blender prereqs installed:false (injected empty PATH)');
  ok(blender.prerequisites.find((p) => p.id === 'git').installHint.length > 0, 'blender git prereq carries an install hint');
  // The Lab client is documented; postSetup warns against the community package.
  ok(blender.postSetup.some((s) => /Blender Lab/i.test(s)), 'blender postSetup references the Blender Lab add-on');
  ok(blender.postSetup.some((s) => /do not|don.?t/i.test(s) && /community|install-addon/i.test(s)),
    'blender postSetup warns against the community add-on / install-addon');
  ok(blender.notes.some((s) => /9876/.test(s)), 'blender notes explain the same-name/same-port 9876 collision');
  ok(blender.installed === false && blender.alreadyEnabled === false, 'blender not installed / not enabled in fresh workspace');
  ok(Array.isArray(blender.postSetup) && blender.postSetup.length > 0, 'blender has postSetup steps');
  ok(Array.isArray(gimp.notes) && gimp.notes.length > 0, 'gimp surfaces honesty notes');
  // JSON must round-trip cleanly (no undefined/functions leak).
  const json = JSON.parse(JSON.stringify(result));
  ok(json.apps[0].id === 'blender', 'buildDetect JSON round-trips cleanly');

  fs.rmSync(root, { recursive: true, force: true });
}

// ── catalog sanity ──────────────────────────────────────────────────────────
{
  const cat = getCatalog('linux');
  ok(cat.length === 2 && cat[0].id === 'blender' && cat[1].id === 'gimp', 'catalog order = blender, gimp');
}

if (failures) { console.error(`\nmcpDetect.smoke: ${failures} FAILED`); process.exit(1); }
console.log('\nmcpDetect.smoke: all passed');
