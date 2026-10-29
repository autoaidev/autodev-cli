// Smoke test for the known/pickable MCP catalog (src/commands/mcp.ts:buildCatalog).
// Run after `npm run build` — imports the compiled JS from out/.
//
// Proves the single-source catalog emits a STABLE shape:
//   - built-ins sourced from DEFAULT_MCP_SERVERS (memory/playwright/
//     sequential-thinking/computer-use-mcp) with kind:'builtin'
//   - filesystem with kind:'common' (a real @modelcontextprotocol config)
//   - blender/gimp with kind:'creative' (gimp experimental:true), platform-aware
//   - every entry carries a non-empty `server`, and JSON round-trips cleanly

import { buildCatalog } from '../out/commands/mcp.js';
import { DEFAULT_MCP_SERVERS } from '../out/mcpManager.js';
import {
  GIMP_CLIENT_PLACEHOLDER, getRemoteCatalog, remoteCatalogEntry,
  remoteServerSpec, maskKey, SYNTHETICMEM_MCP_URL,
} from '../out/core/mcpCatalog.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

const nonEmptyServer = (s) =>
  s && typeof s === 'object' &&
  ((typeof s.command === 'string' && s.command.length > 0 && Array.isArray(s.args)) ||
   (typeof s.url === 'string' && s.url.length > 0));

// ── built-ins sourced from DEFAULT_MCP_SERVERS ──────────────────────────────
{
  const { servers } = buildCatalog('linux');
  ok(Array.isArray(servers) && servers.length >= 7, 'catalog returns >= 7 servers');

  const builtinIds = servers.filter((s) => s.kind === 'builtin').map((s) => s.id);
  for (const name of ['memory', 'playwright', 'sequential-thinking', 'computer-use-mcp']) {
    ok(builtinIds.includes(name), `built-in present: ${name}`);
  }
  // The built-in set is EXACTLY DEFAULT_MCP_SERVERS (sourced, not re-hardcoded).
  const defaultNames = DEFAULT_MCP_SERVERS.map((s) => s.name).sort();
  ok(JSON.stringify(builtinIds.slice().sort()) === JSON.stringify(defaultNames),
    'built-in ids == DEFAULT_MCP_SERVERS names (sourced, not re-hardcoded)');

  // Built-in server config matches DEFAULT_MCP_SERVERS (command/args), tools dropped.
  const mem = servers.find((s) => s.id === 'memory');
  const memDefault = DEFAULT_MCP_SERVERS.find((s) => s.name === 'memory');
  ok(mem && mem.server.command === memDefault.command &&
     JSON.stringify(mem.server.args) === JSON.stringify(memDefault.args),
    'memory server config sourced verbatim from DEFAULT_MCP_SERVERS');
  ok(mem && !('tools' in mem.server), 'built-in server drops copilot-only `tools`');

  for (const s of servers.filter((x) => x.kind === 'builtin')) {
    ok(s.transport === 'stdio' && s.experimental === false && nonEmptyServer(s.server),
      `built-in ${s.id}: stdio, non-experimental, non-empty server`);
  }
}

// ── common: filesystem only, with a REAL config ─────────────────────────────
{
  const { servers } = buildCatalog('linux');
  const common = servers.filter((s) => s.kind === 'common');
  ok(common.length === 1 && common[0].id === 'filesystem', "common == only 'filesystem' (honest, no invented entries)");
  const fs = common[0];
  ok(fs.server.command === 'npx' &&
     fs.server.args.includes('@modelcontextprotocol/server-filesystem'),
    'filesystem uses the real @modelcontextprotocol/server-filesystem via npx');
  ok(nonEmptyServer(fs.server), 'filesystem has a non-empty server');
}

// ── creative: blender/gimp, platform-aware, gimp experimental ───────────────
{
  const { servers } = buildCatalog('linux');
  const blender = servers.find((s) => s.id === 'blender');
  const gimp = servers.find((s) => s.id === 'gimp');
  ok(blender && blender.kind === 'creative' && blender.experimental === false, 'blender kind:creative, experimental:false');
  ok(gimp && gimp.kind === 'creative' && gimp.experimental === true, 'gimp kind:creative, experimental:true');
  ok(blender.requiresApp === 'blender' && gimp.requiresApp === 'gimp', 'creative entries carry requiresApp');
  // Blender uses the OFFICIAL Blender Lab client (uvx --from git+…lab…), NOT the
  // community `uvx blender-mcp` (wrong protocol, collides on port 9876).
  ok(blender.server.command === 'uvx' && nonEmptyServer(blender.server), 'blender server = uvx (linux)');
  ok(blender.server.args.includes('--from') &&
     blender.server.args.some((a) => a.includes('projects.blender.org/lab/blender_mcp')) &&
     blender.server.args.includes('blender-mcp') &&
     !(blender.server.args[0] === 'blender-mcp'),
    'blender server uses the Lab --from git+…lab… client (not bare community blender-mcp)');
  ok(nonEmptyServer(gimp.server), 'gimp has a non-empty server');
  // GIMP (catalog DISPLAY default, pre-install) = `uv run --with mcp==1.2.0
  // <placeholder>` — NOT a stub, NOT python, and NEVER the broken raw-github URL.
  ok(gimp.server.command === 'uv' &&
     gimp.server.args[0] === 'run' &&
     gimp.server.args.includes('--with') &&
     gimp.server.args.includes('mcp==1.2.0') &&
     gimp.server.args[gimp.server.args.length - 1] === GIMP_CLIENT_PLACEHOLDER &&
     !gimp.server.args.some((a) => /raw\.githubusercontent\.com/.test(a)) &&
     gimp.server.enabled === undefined,
    'gimp server = uv run --with mcp==1.2.0 <placeholder> (no stub, no raw-github URL)');

  // Launcher form: bare `uvx` on EVERY platform (no cmd/c wrapper, no hardcoded
  // uvx path) — win32 must be identical to linux.
  const win = buildCatalog('win32');
  const wBlender = win.servers.find((s) => s.id === 'blender');
  ok(wBlender.server.command === 'uvx' &&
     wBlender.server.args[0] === '--from' &&
     wBlender.server.args.some((a) => a.includes('projects.blender.org/lab/blender_mcp')) &&
     JSON.stringify(wBlender.server.args) === JSON.stringify(blender.server.args),
    'blender server is bare uvx --from …lab… on win32 too (no cmd/c, no path)');
}

// ── remote: syntheticmem (hosted MCP, needs a bearer key, no secret in catalog)
{
  const { servers } = buildCatalog('linux');
  const sm = servers.find((s) => s.id === 'syntheticmem');
  ok(sm && sm.kind === 'remote' && sm.transport === 'http' && sm.experimental === false,
    'syntheticmem kind:remote, transport:http, non-experimental');
  ok(sm && sm.server.type === 'http' && sm.server.url === SYNTHETICMEM_MCP_URL,
    'syntheticmem server = http @ syntheticmem.com/api/mcp');
  // CRITICAL: the shared catalog NEVER bakes a key/header (no secret leakage).
  ok(sm && !sm.server.headers, 'syntheticmem catalog server carries NO headers (no secret baked in)');
  ok(sm && sm.auth && sm.auth.header === 'Authorization' && sm.auth.keyPrefix === 'agt_' &&
     typeof sm.auth.demoKeyUrl === 'string' && typeof sm.auth.registerUrl === 'string',
    'syntheticmem carries auth metadata (header, keyPrefix, demoKeyUrl, registerUrl)');

  // remoteServerSpec injects the bearer header ONLY when a key is given.
  const entry = remoteCatalogEntry('syntheticmem');
  ok(entry && entry.id === 'syntheticmem', 'remoteCatalogEntry resolves syntheticmem');
  const keyless = remoteServerSpec(entry);
  ok(keyless.type === 'http' && keyless.url === SYNTHETICMEM_MCP_URL && !keyless.headers,
    'remoteServerSpec(entry) with no key → no headers');
  const withKey = remoteServerSpec(entry, 'agt_abc123def456');
  ok(withKey.headers && withKey.headers.Authorization === 'Bearer agt_abc123def456',
    'remoteServerSpec(entry, key) → Authorization: Bearer <key>');
  // Already-prefixed "Bearer …" is not double-prefixed.
  const pre = remoteServerSpec(entry, 'Bearer agt_zzz');
  ok(pre.headers && pre.headers.Authorization === 'Bearer agt_zzz', 'remoteServerSpec does not double-prefix Bearer');

  // maskKey never reveals the middle of the key.
  const masked = maskKey('agt_SECRETMIDDLE_9999');
  ok(!masked.includes('SECRETMIDDLE') && masked.endsWith('9999') && masked.includes('…'),
    'maskKey hides the middle, keeps a short tail');

  ok(getRemoteCatalog().length >= 1, 'getRemoteCatalog returns >= 1 entry');
}

// ── JSON round-trips cleanly ────────────────────────────────────────────────
{
  const result = buildCatalog('linux');
  const json = JSON.parse(JSON.stringify(result));
  ok(json.servers[0].kind === 'builtin', 'catalog JSON round-trips cleanly (builtins first)');
  for (const s of json.servers) {
    ok(typeof s.id === 'string' && typeof s.name === 'string' &&
       typeof s.description === 'string' && typeof s.kind === 'string' &&
       nonEmptyServer(s.server),
      `entry ${s.id} has the stable field shape`);
  }
}

if (failures) { console.error(`\nmcpCatalog.smoke: ${failures} FAILED`); process.exit(1); }
console.log('\nmcpCatalog.smoke: all passed');
