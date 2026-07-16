// Offline smoke — binding a workspace to an office must write the pixel-office
// (office) MCP server, not just the credential-free built-ins.
//
// The bug: `autodev --setup-url=…` (and `--connect=…`) saved the binding and set
// up the credential-free built-ins (memory/playwright/…) but left the *office*
// MCP server unconfigured — it was only written lazily, whenever the loop next
// started, and could miss its (origin && key) guard. A user reported "it set up
// the others but not the pixel office mcp". applyWsUrl/applySetupUrl now sync the
// MCP config as part of binding. This locks that the office entry lands.
// Run: node test/setupWritesOfficeMcp.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { applyWsUrl } = await import('../out/connect.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function bind() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-setup-mcp-')));
  // A real bind URL: token + endpoint embedded (what the office hands out).
  applyWsUrl(d, 'wss://autodev.code.aioffice.works/ws?token=agt_TESTKEY1234567890&endpoint=legal-parser-test');
  return JSON.parse(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8'));
}

console.log('setup writes office MCP smoke');

const mcp = bind();
const servers = mcp.mcpServers ?? mcp.servers ?? {};

ok('the pixel-office (office) MCP server is written on bind', () => {
  assert.ok(servers['pixel-office'], 'pixel-office entry must exist after binding — this is the whole bug');
});

ok('it is the loop-agent A2A endpoint, authenticated by the agent key', () => {
  const po = servers['pixel-office'];
  assert.strictEqual(po.type, 'http', 'a loop agent gets the remote A2A endpoint');
  assert.match(po.url, /\/api\/mcp\/a2a$/, 'points at the A2A MCP path');
  assert.match(po.headers?.Authorization ?? '', /^Bearer agt_/, 'carries the agent bearer key');
});

ok('the credential-free built-ins are still there (no regression)', () => {
  for (const name of ['memory', 'playwright', 'sequential-thinking']) {
    assert.ok(servers[name], `${name} must still be present`);
  }
});

console.log(`\n${pass} checks passed`);
