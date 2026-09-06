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
// 3. GIMP: a STILL-A-STUB entry (placeholder client) is re-resolved; stays a
//    disabled stub.
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    gimp: { command: 'python', args: [GIMP_CLIENT_PLACEHOLDER], enabled: false, _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux');
  const spec = serverSpecFor('gimp', 'linux');
  const e = readEntry(root, 'gimp');
  ok('gimp stub re-resolved to current catalog command', changed === true && e.command === spec.command);
  ok('gimp stub still carries the placeholder (still a stub)', e.args[0] === GIMP_CLIENT_PLACEHOLDER);
  ok('gimp stub stays disabled', e.enabled === false);
}

// ---------------------------------------------------------------------------
// 4. GIMP: a REAL client path must NEVER be clobbered by the migration.
// ---------------------------------------------------------------------------
{
  const root = mkRoot();
  writeMcp(root, {
    gimp: { command: 'python3', args: ['/opt/gimp-mcp/client.py'], _meta: { kind: 'user' } },
  });
  const changed = migrateCreativeMcpEntries(root, 'linux');
  const e = readEntry(root, 'gimp');
  ok('gimp real client path is preserved (not clobbered)', e.args[0] === '/opt/gimp-mcp/client.py');
  ok('gimp real client path → no migration reported', changed === false);
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
