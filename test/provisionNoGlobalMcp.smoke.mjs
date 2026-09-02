// Offline smoke — binding a workspace to an office must write the pixel-office
// server ONLY into folder-scoped configs, NEVER into a GLOBAL Claude config.
//
// The bug (BUG_REPORT_AUTODEV.md): a pixel-office entry in the user-scope
// ~/.claude.json (top-level mcpServers) or ~/.claude/settings.json is inherited
// by EVERY working directory and respawns un-killably. This locks that current
// provisioning never puts a server DEFINITION into either global file.
// Run: node test/provisionNoGlobalMcp.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME so any "global" write lands in this sandbox, not the real one.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-noglobal-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;

const { applyWsUrl } = await import('../out/connect.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-noglobal-ws-')));
applyWsUrl(ws, 'wss://autodev.code.aioffice.works/ws?token=agt_FAKEKEY123456&endpoint=noglobal-agent');

console.log('provision writes no global MCP smoke');

ok('~/.claude.json has NO top-level mcpServers.pixel-office', () => {
  const p = path.join(HOME, '.claude.json');
  if (!fs.existsSync(p)) return; // fine — nothing global written at all
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!d.mcpServers || !d.mcpServers['pixel-office'], 'must not write a global user-scope server def');
  for (const [k, v] of Object.entries(d.projects ?? {})) {
    assert.ok(!(v && v.mcpServers && v.mcpServers['pixel-office']), `project ${k} must not carry a pixel-office server def in ~/.claude.json`);
  }
});

ok('~/.claude/settings.json has NO mcpServers.pixel-office (user scope)', () => {
  const p = path.join(HOME, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!d.mcpServers || !d.mcpServers['pixel-office'], 'the user-scope settings must not carry the office server def');
});

ok('the office server IS written folder-scoped (.mcp.json)', () => {
  const d = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
  const servers = d.mcpServers ?? d.servers ?? {};
  assert.ok(servers['pixel-office'], 'folder-scoped provisioning must still work');
});

console.log(`\n${pass} checks passed`);
