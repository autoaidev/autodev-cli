// Offline smoke — copilot MCP config must be PER-WORKSPACE.
//
// Copilot's own MCP config (~/.copilot/mcp-config.json) is GLOBAL. The deployer
// runs many agents per box, so every config sync clobbered the previous one and
// each copilot agent ended up pointing at whichever workspace synced most
// recently — driving the WRONG office character.
//
// Fix: write the servers into <workspace>/.autodev/copilot-mcp.json and hand it to
// copilot per session via `--additional-mcp-config @<file>`.
//
// This locks the property that actually matters — two workspaces get two configs,
// each pointing at ITS OWN workspace (the pixel-office entry is now the CLI stdio
// bridge `autodev mcp-operate <root> …`, so it carries the workspace path, not a
// token — mcp-operate reads that workspace's .autodev/settings.json for the key).
// Plus the two halves that make it work end to end: the command passes the file,
// and the stale global entries get pruned.
// Run: node test/copilotMcpIsolation.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cop-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { ConfigManager, copilotMcpConfigPath } = await import('../out/configManager.js');
const { buildCopilotCliCommand } = await import('../out/providers/copilotCliProvider.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function boundWorkspace(key) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cop-')));
  fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(root, '.autodev', 'settings.json'), JSON.stringify({
    serverBaseUrl: 'wss://office.example/ws',
    serverApiKey: key,
  }));
  return root;
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('copilot per-workspace MCP isolation smoke');

// ---------------------------------------------------------------------------
// 1. THE bug: two agents on one box must not share (and clobber) one config.
// ---------------------------------------------------------------------------
ok('two workspaces get their OWN config, each with its own token', () => {
  const a = boundWorkspace('KEY-AAA');
  const b = boundWorkspace('KEY-BBB');
  ConfigManager.syncProjectMcpServers(a);
  ConfigManager.syncProjectMcpServers(b);   // must NOT clobber a

  const ca = read(copilotMcpConfigPath(a));
  const cb = read(copilotMcpConfigPath(b));

  assert.notStrictEqual(copilotMcpConfigPath(a), copilotMcpConfigPath(b), 'configs live in separate workspaces');
  const ta = JSON.stringify(ca.mcpServers['pixel-office']);
  const tb = JSON.stringify(cb.mcpServers['pixel-office']);
  // Each config points at its OWN workspace path (mcp-operate then reads that
  // workspace's settings for the key) — and no token is written into the config.
  assert.ok(ta.includes(a), 'workspace A config points at A');
  assert.ok(tb.includes(b), 'workspace B config points at B');
  assert.ok(!ta.includes(b), 'A must not be clobbered by the later sync of B');
  assert.ok(!ta.includes('KEY-AAA') && !tb.includes('KEY-BBB'), 'no bearer token is written into the copilot config anymore');
});

// ---------------------------------------------------------------------------
// 2. The config is useless unless the command actually passes it.
// ---------------------------------------------------------------------------
ok('command passes --additional-mcp-config @<file> when present', () => {
  const cmd = buildCopilotCliCommand('/ws/.autodev/messages/temp_1.md', undefined, undefined, undefined, '/ws/.autodev/copilot-mcp.json');
  assert.ok(cmd.includes('--additional-mcp-config'), 'flag is passed');
  assert.ok(cmd.includes('"@/ws/.autodev/copilot-mcp.json"'), '@-prefixed path (copilot reads the file)');
});

ok('command omits the flag when no config file (no broken path)', () => {
  const cmd = buildCopilotCliCommand('/ws/.autodev/messages/temp_1.md');
  assert.ok(!cmd.includes('--additional-mcp-config'), 'absent config → flag omitted, prior behaviour');
  assert.ok(cmd.startsWith('copilot '), 'still a valid copilot command');
});

// ---------------------------------------------------------------------------
// 3. The global file must be pruned: `--additional-mcp-config` AUGMENTS it, so a
//    stale pixel-office entry there (another agent's token) would still apply.
// ---------------------------------------------------------------------------
ok('stale pixel-office entries are pruned from the GLOBAL copilot config', () => {
  const globalCfg = path.join(HOME, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(globalCfg), { recursive: true });
  fs.writeFileSync(globalCfg, JSON.stringify({
    mcpServers: {
      'pixel-office': { type: 'http', url: 'https://office.example/api/mcp/a2a', headers: { Authorization: 'Bearer STALE-OTHER-AGENT' } },
      'someone-elses': { type: 'local', command: 'keep-me', args: [] },
    },
  }));

  const root = boundWorkspace('KEY-CCC');
  ConfigManager.syncProjectMcpServers(root);

  const g = read(globalCfg);
  assert.ok(!('pixel-office' in g.mcpServers), 'stale office entry (another agent token) removed');
  assert.ok('someone-elses' in g.mcpServers, "a foreign entry we never managed must be left alone");
});

console.log(`\n${pass} checks passed`);
