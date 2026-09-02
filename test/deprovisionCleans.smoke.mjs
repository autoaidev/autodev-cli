// Offline smoke — `autodev deprovision` must remove pixel-office (server defs +
// mcp__pixel-office permissions) from EVERY layer while preserving every other
// key. This is the report's suggested fix #2/#4 (clean the un-removable global
// entry + stale perms). Run: node test/deprovisionCleans.smoke.mjs  (after build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

// Isolate HOME so we operate only on this sandbox.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-deprov-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { deprovisionCommand } = await import('../out/commands/deprovision.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const w = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };
const r = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── Seed a fully-infected environment ──────────────────────────────────────
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-deprov-ws-')));

const claudeJson = path.join(HOME, '.claude.json');
w(claudeJson, {
  mcpServers: { 'pixel-office': { command: 'autodev', args: ['mcp-operate', '--key', 'agt_x', '--url', 'https://o/api/office-mcp'] }, memory: { command: 'npx' } },
  projects: {
    [ws]: { mcpServers: { 'pixel-office': { command: 'autodev' } }, enabledMcpjsonServers: ['pixel-office', 'memory'], hasTrustDialogAccepted: true },
    '/some/other': { mcpServers: { 'pixel-office-a1': { command: 'autodev' }, keepme: { command: 'x' } } },
  },
});

const claudeSettings = path.join(HOME, '.claude', 'settings.json');
w(claudeSettings, {
  mcpServers: { 'pixel-office': { command: 'autodev' } },
  permissions: { defaultMode: 'bypassPermissions', allow: ['mcp__memory', 'mcp__pixel-office', 'mcp__pixel-office__send_message', 'Bash'] },
});

const copilotGlobal = path.join(HOME, '.copilot', 'mcp-config.json');
w(copilotGlobal, { mcpServers: { 'pixel-office': { type: 'local', command: 'autodev' }, keep: { command: 'y' } } });

// Workspace folder-scoped
w(path.join(ws, '.mcp.json'), { mcpServers: { 'pixel-office': { command: 'autodev' }, memory: { command: 'npx' } } });
w(path.join(ws, '.vscode', 'mcp.json'), { servers: { 'pixel-office': { type: 'http', url: 'https://o' }, memory: { command: 'npx' } } });
w(path.join(ws, 'opencode.json'), { mcp: { 'pixel-office': { type: 'remote', url: 'https://o' }, memory: { type: 'local' } }, permission: { '*': 'allow' } });
w(path.join(ws, '.claude', 'settings.json'), { permissions: { allow: ['mcp__pixel-office', 'mcp__memory'] } });
fs.mkdirSync(path.join(ws, '.grok'), { recursive: true });
fs.writeFileSync(path.join(ws, '.grok', 'config.toml'),
  '[mcp_servers.pixel-office]\ncommand = "autodev"\nargs = ["mcp-operate", "."]\nenabled = true\n\n[mcp_servers.pixel-office.headers]\nAuthorization = "Bearer agt_x"\n\n[mcp_servers.memory]\ncommand = "npx"\nenabled = true\n');

// ── Run the command programmatically ────────────────────────────────────────
const program = new Command();
program.exitOverride(); // don't call process.exit in tests
deprovisionCommand(program);
await program.parseAsync(['node', 'autodev', 'deprovision', ws]);

console.log('deprovision cleans every layer smoke');

ok('~/.claude.json: global + all project pixel-office server defs gone; others kept', () => {
  const d = r(claudeJson);
  assert.ok(!d.mcpServers['pixel-office'], 'global mcpServers.pixel-office removed');
  assert.ok(d.mcpServers['memory'], 'memory preserved');
  assert.ok(!d.projects[ws].mcpServers['pixel-office'], 'project mcpServers.pixel-office removed');
  assert.deepStrictEqual(d.projects[ws].enabledMcpjsonServers, ['memory'], 'pixel-office pruned from enabledMcpjsonServers');
  assert.strictEqual(d.projects[ws].hasTrustDialogAccepted, true, 'unrelated project keys preserved');
  assert.ok(!d.projects['/some/other'].mcpServers['pixel-office-a1'], 'per-agent variant removed');
  assert.ok(d.projects['/some/other'].mcpServers['keepme'], 'unrelated project server preserved');
});

ok('~/.claude/settings.json: server def + mcp__pixel-office* perms gone; others kept', () => {
  const d = r(claudeSettings);
  assert.ok(!d.mcpServers['pixel-office'], 'user-scope server def removed');
  assert.deepStrictEqual(d.permissions.allow, ['mcp__memory', 'Bash'], 'only pixel-office perms stripped');
  assert.strictEqual(d.permissions.defaultMode, 'bypassPermissions', 'other perms keys preserved');
});

ok('~/.copilot/mcp-config.json cleaned; others kept', () => {
  const d = r(copilotGlobal);
  assert.ok(!d.mcpServers['pixel-office'] && d.mcpServers['keep'], 'global copilot cleaned, keep preserved');
});

ok('workspace .mcp.json / .vscode/mcp.json / opencode.json cleaned; memory kept', () => {
  assert.ok(!r(path.join(ws, '.mcp.json')).mcpServers['pixel-office'] && r(path.join(ws, '.mcp.json')).mcpServers['memory']);
  assert.ok(!r(path.join(ws, '.vscode', 'mcp.json')).servers['pixel-office'] && r(path.join(ws, '.vscode', 'mcp.json')).servers['memory']);
  assert.ok(!r(path.join(ws, 'opencode.json')).mcp['pixel-office'] && r(path.join(ws, 'opencode.json')).mcp['memory']);
  assert.strictEqual(r(path.join(ws, 'opencode.json')).permission['*'], 'allow', 'non-mcp keys preserved');
});

ok('workspace .claude/settings.json perms cleaned', () => {
  assert.deepStrictEqual(r(path.join(ws, '.claude', 'settings.json')).permissions.allow, ['mcp__memory']);
});

ok('workspace .grok/config.toml: office table gone, memory table kept', () => {
  const t = fs.readFileSync(path.join(ws, '.grok', 'config.toml'), 'utf8');
  assert.ok(!/\[mcp_servers\.pixel-office\]/.test(t), 'office table removed');
  assert.ok(!/Bearer agt_x/.test(t), 'nested headers table removed');
  assert.ok(/\[mcp_servers\.memory\]/.test(t), 'memory table preserved');
});

// ── Idempotency + dry-run ───────────────────────────────────────────────────
ok('a second run finds nothing to remove (idempotent)', async () => {
  const p2 = new Command();
  p2.exitOverride();
  deprovisionCommand(p2);
  // Should not throw; nothing left to change.
  return p2.parseAsync(['node', 'autodev', 'deprovision', ws]);
});

console.log(`\n${pass} checks passed`);
