// Offline smoke — BUG 3: grok reads the project `.mcp.json`, NOT the
// `.grok/config.toml` AutoDev fans MCP servers into. So EVERY server written to
// `.grok/config.toml` by syncProjectMcpServers must also be present + enabled in
// `<root>/.mcp.json`, or grok can't see it from the workspace.
//
// Run: node test/grokMcpParity.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConfigManager } = require('../out/configManager.js');
const { saveProjectUserMcp, ensureProjectMcpServersPresent } = require('../out/core/projectMcp.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-parity-')));
}
function grokNames(root) {
  const p = path.join(root, '.grok', 'config.toml');
  if (!fs.existsSync(p)) { return []; }
  const toml = fs.readFileSync(p, 'utf8');
  return [...toml.matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)].map(m => m[1]).sort();
}
function mcpJsonEnabled(root) {
  const p = path.join(root, '.mcp.json');
  if (!fs.existsSync(p)) { return []; }
  const mcp = JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers || {};
  return Object.entries(mcp).filter(([, e]) => e.enabled !== false).map(([n]) => n).sort();
}

console.log('grokMcpParity smoke');

// ── Core invariant: after a full sync, grok's server set ⊆ .mcp.json enabled. ──
ok('syncProjectMcpServers: every grok .grok/config.toml server is enabled in .mcp.json', () => {
  const d = tmpRoot();
  // A creative/user server (blender) + the builtins fanned in by the sync.
  saveProjectUserMcp(d, { blender: { command: 'uvx', args: ['blender-mcp'], _meta: { catalogId: 'blender' } } });
  ConfigManager.syncProjectMcpServers(d, () => {});

  const grok = grokNames(d);
  const mcp = mcpJsonEnabled(d);
  assert.ok(grok.length > 0, 'precondition: grok config must carry MCP servers');
  assert.ok(grok.includes('blender'), 'the creative server must reach grok');
  const missing = grok.filter(n => !mcp.includes(n));
  assert.deepStrictEqual(missing, [], `grok servers missing/disabled in .mcp.json: ${missing.join(', ')}`);
});

// ── The reconcile heals an injected gap (a server in the effective/grok set that
//    is present-but-DISABLED in .mcp.json) so grok can load it. ──
ok('ensureProjectMcpServersPresent: re-enables a present-but-disabled effective server', () => {
  const d = tmpRoot();
  // Seed .mcp.json with a disabled blender (credentials preserved, but grok-invisible).
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({
    mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'], enabled: false, _meta: { kind: 'user', token: 'keep-me' } } },
  }, null, 2));
  const touched = ensureProjectMcpServersPresent(
    d,
    { blender: { command: 'uvx', args: ['blender-mcp'] } },   // effective (enabled) set
    new Set(),                                                // blender is a user server
  );
  assert.deepStrictEqual(touched, ['blender'], 'the disabled server must be re-enabled');
  const mcp = JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers;
  assert.notStrictEqual(mcp.blender.enabled, false, 'blender must no longer be disabled');
  assert.strictEqual(mcp.blender._meta.token, 'keep-me', 'existing credentials/_meta must be preserved (merge, not clobber)');
});

// ── The reconcile ADDS a missing effective server (tagged by builtin-ness) and is
//    a no-op when parity already holds. ──
ok('ensureProjectMcpServersPresent: adds a missing server, then is idempotent', () => {
  const d = tmpRoot();
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  const eff = {
    memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    'pixel-office': { type: 'http', url: 'https://example/api/mcp/a2a', headers: { Authorization: 'Bearer abc' } },
  };
  const added = ensureProjectMcpServersPresent(d, eff, new Set(['memory', 'pixel-office'])).sort();
  assert.deepStrictEqual(added, ['memory', 'pixel-office'], 'both missing servers must be added');
  const mcp = JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers;
  assert.strictEqual(mcp.memory._meta.kind, 'builtin', 'builtin tag applied');
  assert.strictEqual(mcp['pixel-office']._meta.kind, 'builtin', 'builtin tag applied');
  assert.strictEqual(mcp['pixel-office'].headers.Authorization, 'Bearer abc', 'remote headers/token preserved');
  // Second pass — nothing left to do.
  assert.deepStrictEqual(ensureProjectMcpServersPresent(d, eff, new Set(['memory', 'pixel-office'])), [], 'idempotent');
});

// ── FIX 2: the 4 core built-ins (memory/playwright/sequential-thinking/
//    computer-use-mcp) are NON-DISABLEABLE — even with them listed in
//    disabledBuiltinMcp, syncProjectMcpServers must still write them ENABLED as
//    builtin entries into .mcp.json. (pixel-office remains suppressible.) ──
ok('syncProjectMcpServers: disabledBuiltinMcp cannot drop the core built-ins', () => {
  const d = tmpRoot();
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(
    path.join(d, '.autodev', 'settings.json'),
    JSON.stringify({ disabledBuiltinMcp: ['memory', 'sequential-thinking'] }, null, 2),
  );
  ConfigManager.syncProjectMcpServers(d, () => {});

  const mcp = JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers || {};
  for (const name of ['memory', 'sequential-thinking', 'playwright', 'computer-use-mcp']) {
    assert.ok(mcp[name], `${name} must be present in .mcp.json despite disabledBuiltinMcp`);
    assert.notStrictEqual(mcp[name].enabled, false, `${name} must be ENABLED`);
    assert.strictEqual(mcp[name]._meta?.kind, 'builtin', `${name} must be tagged builtin`);
  }
});

console.log(`\ngrokMcpParity smoke: ${pass} passed`);
