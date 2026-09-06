// Offline smoke — auto-migration of STALE creative-app MCP entries on sync.
//
// The bug: a creative-app server (Blender/GIMP) enabled BEFORE the catalog was
// corrected snapshotted the OLD spec into the agent's .mcp.json as a user entry.
// syncProjectMcpServers just fanned that stale entry out to every provider, so
// users kept getting the broken command after updating.
//
// Fix: migrateCreativeMcpEntries re-resolves creative user entries from the
// CURRENT catalog (serverSpecFor) and persists the upgrade back to .mcp.json
// BEFORE the fan-out — blender ALWAYS, gimp only while still a stub; enabled/env
// preserved; idempotent.
// Run: node test/mcpCatalogMigrate.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mig-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { migrateCreativeMcpEntries } = await import('../out/core/mcpCatalogMigrate.js');
const { serverSpecFor, GIMP_CLIENT_PLACEHOLDER } = await import('../out/core/mcpCatalog.js');
const { loadProjectAllMcp } = await import('../out/core/projectMcp.js');
const { ConfigManager } = await import('../out/configManager.js');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };
const eqArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mkRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mig-')));
}
function writeMcp(root, servers) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}
function readEntry(root, name) {
  return loadProjectAllMcp(root)[name];
}

console.log('creative-app MCP migration smoke');

// ---------------------------------------------------------------------------
// 1. THE bug: a stale community `cmd /c uvx blender-mcp` entry (old win form) is
//    re-resolved to the current bare-uvx Blender Lab spec. enabled + env preserved.
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    blender: { command: 'cmd', args: ['/c', 'uvx', 'blender-mcp'], enabled: true, env: { FOO: 'bar' }, _meta: { kind: 'user' } },
  });
  const before = readEntry(root, 'blender');
  const changed = migrateCreativeMcpEntries(root, 'linux');
  const spec = serverSpecFor('blender', 'linux');
  const e = readEntry(root, 'blender');
  console.log('    before:', JSON.stringify({ command: before.command, args: before.args }));
  console.log('    after :', JSON.stringify({ command: e.command, args: e.args }));
  ok('migration reported a change', changed === true);
  ok('stale cmd /c uvx blender-mcp → bare uvx (command)', e.command === 'uvx' && e.command === spec.command);
  ok('stale blender → Lab --from git+…lab… args', eqArgs(e.args, spec.args) &&
     e.args.includes('--from') && e.args.some((a) => a.includes('projects.blender.org/lab/blender_mcp')));
  ok('no cmd/c wrapper survives', e.command !== 'cmd' && !e.args.includes('/c'));
  ok('enabled preserved (not forced disabled)', e.enabled !== false);
  ok('user env preserved', e.env && e.env.FOO === 'bar');
}

// ---------------------------------------------------------------------------
// 2. Full sync path: a stale non-win community `uvx blender-mcp` entry gets the
//    corrected command in .mcp.json AND fanned out to a provider config (grok).
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    blender: { command: 'uvx', args: ['blender-mcp'], _meta: { kind: 'user' } },
  });
  ConfigManager.syncProjectMcpServers(root);
  const spec = serverSpecFor('blender', process.platform);
  const e = readEntry(root, 'blender');
  ok('sync migrates uvx blender-mcp → Lab args in .mcp.json', e.command === 'uvx' && eqArgs(e.args, spec.args));
  const toml = fs.readFileSync(path.join(root, '.grok', 'config.toml'), 'utf8');
  ok('grok config.toml got the corrected Lab --from client (fan-out)',
     /projects\.blender\.org\/lab\/blender_mcp/.test(toml) && /command = "uvx"/.test(toml));
  ok('grok config.toml no longer carries the bare community blender-mcp form',
     !/args = \["blender-mcp"\]/.test(toml));
}

// ---------------------------------------------------------------------------
// 3. GIMP: the BROKEN raw-github upstream client is upgraded to the
//    LOCALLY-INSTALLED client form (`uv run --with mcp==1.2.0 <local path>`)
//    when GIMP is detected (injected resolver). enabled preserved; URL gone.
// ---------------------------------------------------------------------------
const LOCAL_CLIENT = '/home/u/.config/GIMP/3.2/mcp/gimp_mcp_client.py';
{
  const root = mkRoot();
  const RAW = 'https://raw.githubusercontent.com/libreearth/gimp-mcp/49c46dd/gimp_mcp_client.py';
  writeMcp(root, {
    gimp: { command: 'uv', args: ['run', '--with', 'mcp==1.2.0', RAW], enabled: false, _meta: { kind: 'user' } },
  });
  const before = readEntry(root, 'gimp');
  const changed = migrateCreativeMcpEntries(root, 'linux', undefined, { resolveGimpClient: () => LOCAL_CLIENT });
  const spec = serverSpecFor('gimp', 'linux', { gimpClientPath: LOCAL_CLIENT });
  const e = readEntry(root, 'gimp');
  console.log('    before:', JSON.stringify({ command: before.command, args: before.args }));
  console.log('    after :', JSON.stringify({ command: e.command, args: e.args }));
  ok('raw-url gimp upgraded to uv command', changed === true && e.command === 'uv' && e.command === spec.command);
  ok('raw-url gimp args → uv run --with mcp==1.2.0 <local client path>', eqArgs(e.args, spec.args) &&
     e.args[0] === 'run' && e.args[e.args.length - 1] === LOCAL_CLIENT);
  ok('broken raw-github URL is gone', !e.args.some((a) => /raw\.githubusercontent\.com/.test(a)));
  ok('gimp enabled state preserved (stayed disabled)', e.enabled === false);
}

// 3b. The OLD <…> placeholder python stub is likewise upgraded (resolver present).
{
  const root = mkRoot();
  writeMcp(root, {
    gimp: { command: 'python', args: [GIMP_CLIENT_PLACEHOLDER], enabled: true, _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux', undefined, { resolveGimpClient: () => LOCAL_CLIENT });
  const e = readEntry(root, 'gimp');
  ok('old placeholder stub upgraded to uv local form', changed === true && e.command === 'uv' &&
     e.args[e.args.length - 1] === LOCAL_CLIENT);
  ok('placeholder is gone (no longer a stub)', !e.args.includes(GIMP_CLIENT_PLACEHOLDER));
  ok('gimp enabled preserved (stayed enabled)', e.enabled !== false);
}

// 3c. GIMP NOT installed (resolver → null): a raw-url entry is LEFT AS-IS — the
//     migration never NEWLY writes the broken URL, and can't compute a local path.
{
  const root = mkRoot();
  const RAW = 'https://raw.githubusercontent.com/libreearth/gimp-mcp/49c46dd/gimp_mcp_client.py';
  writeMcp(root, {
    gimp: { command: 'uv', args: ['run', '--with', 'mcp==1.2.0', RAW], _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux', undefined, { resolveGimpClient: () => null });
  const e = readEntry(root, 'gimp');
  ok('no GIMP → raw-url gimp entry left as-is (no migration reported)', changed === false && e.args[e.args.length - 1] === RAW);
}

// ---------------------------------------------------------------------------
// 4. GIMP: a REAL concrete client path must NEVER be clobbered — both the legacy
//    python[3] <path> form AND the current `uv run … <local path>` form.
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    gimp: { command: 'python3', args: ['/opt/gimp-mcp/client.py'], _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux', undefined, { resolveGimpClient: () => LOCAL_CLIENT });
  const e = readEntry(root, 'gimp');
  ok('gimp real python client path is preserved (not clobbered)', e.args[0] === '/opt/gimp-mcp/client.py');
  ok('gimp real client path → no migration reported', changed === false);
}
{
  const root = mkRoot();
  writeMcp(root, {
    gimp: { command: 'uv', args: ['run', '--with', 'mcp==1.2.0', '/opt/mine/gimp_mcp_client.py'], _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux', undefined, { resolveGimpClient: () => LOCAL_CLIENT });
  const e = readEntry(root, 'gimp');
  ok('gimp concrete uv-run local client preserved (idempotent, not re-pointed)',
     changed === false && e.args[e.args.length - 1] === '/opt/mine/gimp_mcp_client.py');
}

// ---------------------------------------------------------------------------
// 5. Idempotent: an already-Lab blender entry is left untouched.
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  const spec = serverSpecFor('blender', process.platform);
  writeMcp(root, {
    blender: { command: spec.command, args: spec.args, _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, process.platform);
  ok('already-Lab blender is unchanged (idempotent)', changed === false);
}

// ---------------------------------------------------------------------------
// 6. Non-creative user entries are never touched (scope guard).
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<ALLOWED_DIR>'], _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux');
  const e = readEntry(root, 'filesystem');
  ok('non-creative filesystem entry left alone', changed === false && e.args.includes('<ALLOWED_DIR>'));
}

console.log(`\n${pass} checks passed`);
