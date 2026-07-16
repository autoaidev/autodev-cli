// Offline smoke — the MCP-only OPERATOR wiring.
//
// A pure-MCP office agent (no autodev loop) — e.g. opencode/Kimi or Claude Code
// pointed at the office — depends entirely on WHICH office MCP the config sync
// wires in:
//
//   • Loop agent (mcpOnly:false, the default): the A2A REMOTE
//     (…/api/mcp/a2a) — messaging only. Fine, because a loop agent has its own
//     WebSocket presence + task loop.
//   • MCP-only agent (mcpOnly:true): the OPERATOR bridge —
//     `autodev mcp-operate <root>` (a local stdio server that speaks to
//     …/api/office-mcp). It registers presence AND exposes the full agent
//     toolkit (tasks/report/status) plus A2A, so the client is a real, online
//     office agent rather than a messaging-only, offline one.
//
// This locks that branch so the two agent types never silently collapse into
// one. Fully offline: HOME is redirected to a temp dir so the global copilot
// config write can't touch the real one; no network, no CLI binaries spawned.
// Run: node test/mcpOnlyOperator.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox HOME before importing anything that may resolve global config paths
// (ConfigManager writes ~/.copilot/mcp-config.json).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcponly-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { ConfigManager } = await import('../out/configManager.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function boundWorkspace(mcpOnly) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcponly-')));
  fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.autodev', 'settings.json'),
    JSON.stringify({
      serverBaseUrl: 'wss://office.example/ws',
      serverApiKey: 'AGENTKEY',
      ...(mcpOnly ? { mcpOnly: true } : {}),
    }, null, 2),
  );
  return root;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('mcp-only operator wiring smoke');

// ---------------------------------------------------------------------------
// 1. Loop agent (default): A2A remote — messaging only.
// ---------------------------------------------------------------------------
ok('loop agent → pixel-office is the A2A bridge via the autodev CLI (no token in file)', () => {
  const root = boundWorkspace(false);
  ConfigManager.syncProjectMcpServers(root);

  const oc = readJson(path.join(root, 'opencode.json'));
  const po = oc.mcp?.['pixel-office'];
  assert.ok(po, 'opencode.json has a pixel-office server');
  // Now a local stdio bridge (the CLI reads the key from settings) instead of a
  // remote http entry with an embedded Authorization: Bearer header.
  assert.strictEqual(po.type, 'local', 'loop agent uses the local CLI stdio bridge');
  assert.ok(Array.isArray(po.command), 'has a local command array');
  assert.strictEqual(po.command[0], 'autodev', 'runs the autodev CLI binary');
  assert.ok(po.command.includes('mcp-operate'), 'via the mcp-operate bridge');
  assert.strictEqual(po.command[2], '.', 'relative workspace path (portable config)');
  const urlArg = po.command[po.command.indexOf('--url') + 1] ?? '';
  assert.strictEqual(urlArg, 'https://office.example/api/mcp/a2a', 'bridges to the A2A endpoint, wss→https normalised');
  assert.ok(!po.command.includes('--no-socket'), 'presence socket stays ON');
});

// ---------------------------------------------------------------------------
// 2. MCP-only agent: operator bridge — local stdio, full toolkit + presence.
// ---------------------------------------------------------------------------
ok('mcp-only agent → pixel-office is the OPERATOR bridge (autodev mcp-operate <root>)', () => {
  const root = boundWorkspace(true);
  ConfigManager.syncProjectMcpServers(root);

  const oc = readJson(path.join(root, 'opencode.json'));
  const po = oc.mcp?.['pixel-office'];
  assert.ok(po, 'opencode.json has a pixel-office server');
  assert.strictEqual(po.type, 'local', 'mcp-only agent uses a local stdio bridge');
  assert.deepStrictEqual(po.command, ['autodev', 'mcp-operate', '.'], 'bridges via `autodev mcp-operate .` (relative, operator/office-mcp default)');
  assert.strictEqual(po.enabled, true);
});

// ---------------------------------------------------------------------------
// 3. The operator carries no bearer token in the config file (it reads the
//    workspace binding), unlike the A2A remote's Authorization header.
// ---------------------------------------------------------------------------
ok('mcp-only operator entry leaks no api_key into the provider config', () => {
  const root = boundWorkspace(true);
  ConfigManager.syncProjectMcpServers(root);

  const raw = fs.readFileSync(path.join(root, 'opencode.json'), 'utf8');
  assert.ok(!raw.includes('AGENTKEY'), 'no api_key written into opencode.json for the operator bridge');

  // And it is mirrored into the canonical .mcp.json as a built-in.
  const mcp = readJson(path.join(root, '.mcp.json'));
  const entry = mcp.mcpServers?.['pixel-office'] ?? mcp['pixel-office'];
  assert.ok(entry, '.mcp.json carries the pixel-office built-in');
});

// ---------------------------------------------------------------------------
// 3b. Grok gets the SAME operator wiring — the mcp-only fix must not be
//     opencode-only. Grok's config is TOML (.grok/config.toml), a separate
//     writer, so it needs its own assertion.
// ---------------------------------------------------------------------------
ok('grok loop agent → .grok/config.toml pixel-office is the CLI A2A bridge (no token)', () => {
  const root = boundWorkspace(false);
  ConfigManager.syncProjectMcpServers(root);
  const toml = fs.readFileSync(path.join(root, '.grok', 'config.toml'), 'utf8');
  assert.ok(/\[mcp_servers\.pixel-office\]/.test(toml), 'has a pixel-office mcp_servers block');
  assert.ok(/command\s*=\s*"autodev"/.test(toml), 'loop grok now bridges via the autodev CLI');
  assert.ok(toml.includes('/api/mcp/a2a'), 'loop grok points at the A2A endpoint');
  assert.ok(!toml.includes('--no-socket'), 'loop grok keeps the presence socket on');
  assert.ok(!toml.includes('AGENTKEY'), 'no api_key leaked into the grok config');
});

ok('grok mcp-only agent → .grok/config.toml pixel-office is the operator command', () => {
  const root = boundWorkspace(true);
  ConfigManager.syncProjectMcpServers(root);
  const toml = fs.readFileSync(path.join(root, '.grok', 'config.toml'), 'utf8');
  assert.ok(/\[mcp_servers\.pixel-office\]/.test(toml), 'has a pixel-office mcp_servers block');
  assert.ok(/command\s*=\s*"autodev"/.test(toml), 'mcp-only grok bridges via autodev');
  assert.ok(/args\s*=\s*\[\s*"mcp-operate"/.test(toml), 'args start with mcp-operate');
  assert.ok(!toml.includes('/api/mcp/a2a'), 'mcp-only grok does NOT use the messaging-only A2A endpoint');
  assert.ok(!toml.includes('AGENTKEY'), 'no api_key leaked into the grok config');
});

// ---------------------------------------------------------------------------
// 4. Same office, the only difference is the flag → the two modes really are
//    distinct wirings (guards against a regression that ties them together).
// ---------------------------------------------------------------------------
ok('loop vs mcp-only produce different pixel-office wirings from the same binding', () => {
  const loop = boundWorkspace(false);
  const only = boundWorkspace(true);
  ConfigManager.syncProjectMcpServers(loop);
  ConfigManager.syncProjectMcpServers(only);
  const a = readJson(path.join(loop, 'opencode.json')).mcp['pixel-office'];
  const b = readJson(path.join(only, 'opencode.json')).mcp['pixel-office'];
  assert.notDeepStrictEqual(a, b, 'the flag must change the wiring');
  // Both go through the CLI stdio bridge now (no token in the file either way);
  // the flag changes the ARGS: loop bridges to A2A with --no-socket, mcp-only
  // bridges to the operator (office-mcp) with presence.
  assert.strictEqual(a.type, 'local');
  assert.strictEqual(b.type, 'local');
  assert.ok(a.command.includes('--url'), 'loop bridges to the A2A endpoint');
  assert.ok(!b.command.includes('--url'), 'mcp-only uses the operator (office-mcp) default');
  assert.ok(!a.command.includes('--no-socket') && !b.command.includes('--no-socket'), 'both keep the presence socket');
  assert.notDeepStrictEqual(a.command, b.command, 'the args differ by mode');
});

console.log(`\n${pass} checks passed`);
