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
import { serverSpecFor, getCatalog, GIMP_CLIENT_PLACEHOLDER, GIMP_MCP_PIN } from '../out/core/mcpCatalog.js';
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
// (runWhich:()=>null keeps this hermetic regardless of the real host's PATH.)
{
  const emptyFs = makeFs([]);
  const res = detectApp('blender', {
    platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', runWhich: () => null, ...emptyFs,
  });
  ok(res.installed === false && res.path === null && res.source === null, 'blender not-installed → false/null/null');
}

// ── (c) detectApp gimp: PATH hit on linux; and app-bundle on mac ────────────
// runWhich:()=>null forces the manual fileExists parse (what these cases test).
{
  const linFs = makeFs(['/usr/bin/gimp-2.10']);
  const res = detectApp('gimp', {
    platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', runWhich: () => null, ...linFs,
  });
  ok(res.installed === true && res.source === 'path', 'gimp detected on PATH (gimp-2.10, linux)');

  const macFs = makeFs(['/Applications/GIMP.app/Contents/MacOS/gimp']);
  const macRes = detectApp('gimp', {
    platform: 'darwin', env: { PATH: '/usr/bin' }, homedir: () => '/Users/u', runWhich: () => null, ...macFs,
  });
  ok(macRes.installed === true && macRes.source === 'app-bundle', 'gimp detected via /Applications bundle (mac)');
}

// ── (c1b) THE BUG: Windows execution-alias reparse stub ─────────────────────
// GIMP 3.x from the Store leaves an AppExecLink reparse stub on PATH at
// %LOCALAPPDATA%\Microsoft\WindowsApps\gimp-3.exe. Node's fs.existsSync/statSync
// FAIL on that reparse point → fileExists returns FALSE, so the old dir-glob
// probe could not see it. But `where gimp-3` DOES resolve it. This simulates
// exactly that: fileExists is FALSE everywhere, yet runWhich('gimp-3') returns
// the alias path → detection MUST succeed via the OS-native resolver.
{
  const aliasPath = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\gimp-3.exe';
  const res = detectApp('gimp', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user',
    // The reparse stub: fileExists FAILS for it (statSync throws on the reparse point).
    fileExists: () => false,
    listDir: () => [],
    // `where gimp-3` authoritatively resolves the alias, other names not found.
    runWhich: (name) => (name === 'gimp-3' ? aliasPath + '\r\n' : null),
  });
  ok(res.installed === true, 'gimp reparse-stub detected via `where` even when fileExists FAILS');
  ok(res.path === aliasPath, 'gimp reparse-stub path is the resolved WindowsApps alias');
  ok(res.source === 'store', 'gimp reparse-stub source = store (path is under \\Microsoft\\WindowsApps\\)');

  // Not-found: runWhich returns null (throws/non-zero) AND no dirs → installed:false.
  const none = detectApp('gimp', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user',
    fileExists: () => false,
    listDir: () => [],
    runWhich: () => { throw new Error('INFO: Could not find files'); }, // `where` exits non-zero → execFileSync throws
  });
  ok(none.installed === false && none.path === null && none.source === null,
    'gimp not-found (runWhich throws, no dirs) → false/null/null');

  // A plain PATH resolution (not under WindowsApps) → source 'path', not 'store'.
  const onPath = detectApp('gimp', {
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.EXE' },
    homedir: () => 'C:\\Users\\user',
    fileExists: () => false,
    listDir: () => [],
    runWhich: (name) => (name === 'gimp-3.2' ? 'C:\\tools\\gimp-3.2.exe' : null),
  });
  ok(onPath.installed === true && onPath.path === 'C:\\tools\\gimp-3.2.exe' && onPath.source === 'path',
    'gimp resolved by `where` outside WindowsApps → source path');

  // Blender parity: reparse-stub alias resolved via `where blender`.
  const bAlias = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\blender.exe';
  const bRes = detectApp('blender', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user',
    fileExists: () => false,
    listDir: () => [],
    runWhich: (name) => (name === 'blender' ? bAlias : null),
  });
  ok(bRes.installed === true && bRes.path === bAlias && bRes.source === 'store',
    'blender reparse-stub detected via `where` (fileExists FAILS) → source store');
}

// ── (c1c) detectBinOnPath native fallback (uvx/git reparse robustness) ───────
{
  const found = detectBinOnPath('uvx', {
    platform: 'win32', env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE' },
    homedir: () => 'C:\\Users\\user', fileExists: () => false, listDir: () => [],
    runWhich: (name) => (name === 'uvx' ? 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\uvx.exe' : null),
  });
  ok(found === 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\uvx.exe',
    'detectBinOnPath falls back to `where` for a reparse-stub uvx (fileExists FAILS)');
}

// ── (c2) Microsoft Store / execution-alias installs on win32 ────────────────
// GIMP 3.x from the Store leaves a 0-byte alias stub on PATH at
// %LOCALAPPDATA%\Microsoft\WindowsApps\gimp-3.exe and NO Program Files\GIMP dir.
{
  const localAppData = 'C:\\Users\\user\\AppData\\Local';
  const aliasDir = path.join(localAppData, 'Microsoft', 'WindowsApps');
  const gimpAlias = path.join(aliasDir, 'gimp-3.exe'); // 0-byte stub, but exists
  const storeFs = makeFs([gimpAlias]);
  const res = detectApp('gimp', {
    platform: 'win32',
    // PATH deliberately does NOT include WindowsApps, so the ONLY way this is
    // found is the explicit alias-dir probe (proving the new behavior).
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: localAppData, PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user', ...storeFs,
  });
  ok(res.installed === true, 'gimp Store alias (gimp-3.exe) detected on win32');
  ok(res.path === gimpAlias, 'gimp Store path is the %LOCALAPPDATA%\\Microsoft\\WindowsApps\\gimp-3.exe stub');
  ok(res.source === 'store', 'gimp Store source = store');

  // Same fake fs but NO gimp anywhere → not installed.
  const emptyRes = detectApp('gimp', {
    platform: 'win32', env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: localAppData, PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user', ...makeFs([]),
  });
  ok(emptyRes.installed === false && emptyRes.path === null && emptyRes.source === null, 'gimp not-installed (win32, no Store/classic) → false/null/null');

  // Classic Program Files GIMP still detected (regression guard).
  const pf = 'C:\\Program Files';
  const gbin = path.join(pf, 'GIMP 2', 'bin');
  const gexe = path.join(gbin, 'gimp-2.10.exe');
  const classicFs = makeFs([gexe], { [pf]: ['GIMP 2'], [gbin]: ['gimp-2.10.exe'] });
  const classicRes = detectApp('gimp', {
    platform: 'win32', env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', PROGRAMFILES: pf },
    homedir: () => 'C:\\Users\\user', ...classicFs,
  });
  ok(classicRes.installed === true && classicRes.path === gexe && classicRes.source === 'program-files',
    'classic Program Files\\GIMP 2 still detected (source program-files)');

  // ACL-locked WindowsApps package glob must not throw even when listDir denies.
  const throwingDeps = {
    platform: 'win32', env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: localAppData, PROGRAMFILES: pf },
    homedir: () => 'C:\\Users\\user',
    fileExists: () => false,
    // Only the ACL-locked %ProgramFiles%\WindowsApps throws; the user-owned
    // %LOCALAPPDATA%\Microsoft\WindowsApps alias dir lists normally.
    listDir: (p) => { if (String(p).includes('Program Files') && String(p).includes('WindowsApps')) { throw new Error('EACCES'); } return []; },
  };
  let threw = false;
  let aclRes;
  try { aclRes = detectApp('gimp', throwingDeps); } catch { threw = true; }
  ok(!threw, 'ACL-locked WindowsApps listDir throwing does NOT break gimp detection');
  ok(aclRes && aclRes.installed === false, 'gimp with throwing WindowsApps + nothing present → not installed');
}

// Blender parity: Store execution-alias stub blender.exe on win32.
{
  const localAppData = 'C:\\Users\\user\\AppData\\Local';
  const aliasDir = path.join(localAppData, 'Microsoft', 'WindowsApps');
  const blenderAlias = path.join(aliasDir, 'blender.exe');
  const storeFs = makeFs([blenderAlias]);
  const res = detectApp('blender', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', LOCALAPPDATA: localAppData, PROGRAMFILES: 'C:\\Program Files' },
    homedir: () => 'C:\\Users\\user', ...storeFs,
  });
  ok(res.installed === true && res.path === blenderAlias && res.source === 'store',
    'blender Store alias (blender.exe) detected on win32 with source=store');
}

// ── (d) serverSpecFor platform-awareness + gimp stub ────────────────────────
{
  const LAB_FROM = 'git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp';
  const bLinux = serverSpecFor('blender', 'linux');
  ok(bLinux.command === 'uvx' &&
     JSON.stringify(bLinux.args) === JSON.stringify(['--from', LAB_FROM, '--with', 'mcp<2', 'blender-mcp']),
    'blender server (non-win) = uvx --from git+…lab… --with "mcp<2" blender-mcp (official Lab client)');
  const bWin = serverSpecFor('blender', 'win32');
  ok(bWin.command === 'uvx' &&
     JSON.stringify(bWin.args) === JSON.stringify(['--from', LAB_FROM, '--with', 'mcp<2', 'blender-mcp']),
    'blender server (win32) = bare uvx --from git+…lab… (no cmd/c wrapper, no hardcoded path)');

  // DEFAULT gimp (no client path yet) = `uv run --with mcp==1.2.0 <placeholder>` —
  // NEVER the broken raw-github upstream client. Identical on every platform.
  const gLinux = serverSpecFor('gimp', 'linux');
  ok(gLinux.command === 'uv' &&
     JSON.stringify(gLinux.args) === JSON.stringify(['run', '--with', GIMP_MCP_PIN, GIMP_CLIENT_PLACEHOLDER]) &&
     gLinux.enabled === undefined,
    'gimp server (default) = uv run --with mcp==1.2.0 <placeholder>, enabled (no stub)');
  const gWin = serverSpecFor('gimp', 'win32');
  ok(gWin.command === 'uv' && JSON.stringify(gWin.args) === JSON.stringify(gLinux.args),
    'gimp server is identical bare `uv` on win32 (no cmd/c, no path divergence)');
  ok(GIMP_MCP_PIN === 'mcp==1.2.0', 'gimp client pin is mcp==1.2.0');
  ok(!gLinux.args.some((a) => /raw\.githubusercontent\.com/.test(a)),
    'gimp default NEVER emits the broken raw-github upstream client');
  // With a resolved/installed client path → `uv run --with mcp==1.2.0 <that path>`.
  const gReal = serverSpecFor('gimp', 'linux', { gimpClientPath: '/home/u/.config/GIMP/3.2/mcp/gimp_mcp_client.py' });
  ok(gReal.command === 'uv' && gReal.enabled === undefined &&
     JSON.stringify(gReal.args) === JSON.stringify(['run', '--with', GIMP_MCP_PIN, '/home/u/.config/GIMP/3.2/mcp/gimp_mcp_client.py']),
    'gimp with a client path → uv run --with mcp==1.2.0 <local client path>');
}

// ── (e) buildDetect stable shape ────────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-detect-'));
  // Inject linux deps with nothing installed so the shape is deterministic.
  const emptyFs = makeFs([]);
  const result = buildDetect(root, {
    platform: 'linux', env: { PATH: '/nowhere' }, homedir: () => '/home/u', runWhich: () => null, ...emptyFs,
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
  ok(gimp.server.command === 'uv' && gimp.server.args[0] === 'run', 'gimp server spec = uv run (git-based client)');
  ok(gimp.prerequisites.map((p) => p.id).includes('uv'), 'gimp prerequisite is uv (uv run fetches the client)');
  ok(gimp.postSetup.some((s) => /Start MCP Server/i.test(s) && /keep/i.test(s)),
    'gimp postSetup tells the user to Start MCP Server and keep the window open (menu-triggered)');
  ok(gimp.postSetup.some((s) => /installed automatically/i.test(s)),
    'gimp postSetup says the plugin + client are installed automatically');
  ok(gimp.postSetup.some((s) => /GIMP 3\.x/i.test(s)), 'gimp postSetup requires GIMP 3.x');
  ok(gimp.postSetup.some((s) => /9876/.test(s)), 'gimp postSetup notes the port-9876 Blender collision');
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
