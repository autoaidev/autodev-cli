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
  ok(blender.server.command === 'uvx' && nonEmptyServer(blender.server), 'blender server = uvx blender-mcp (linux)');
  ok(nonEmptyServer(gimp.server), 'gimp has a non-empty server');

  // Platform-awareness: on win32 blender is wrapped in cmd /c.
  const win = buildCatalog('win32');
  const wBlender = win.servers.find((s) => s.id === 'blender');
  ok(wBlender.server.command === 'cmd', 'blender server is platform-aware (cmd /c on win32)');
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
