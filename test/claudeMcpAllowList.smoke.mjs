// Offline smoke — the Claude `.claude/settings.json` permissions.allow list (and
// the ~/.claude.json enabledMcpjsonServers loading gate) must be derived from the
// EFFECTIVE ENABLED MCP set, NOT a hardcoded built-ins-only list. Regression: a
// user/creative server like `blender` sat in .mcp.json but Claude silently omitted
// it because it had no `mcp__blender` allow rule and wasn't in enabledMcpjsonServers.
//
// This locks:
//   - after syncProjectMcpServers with blender enabled in .mcp.json, the project
//     allow list contains mcp__blender AND the built-ins (memory/playwright/…);
//   - a pre-existing NON-mcp allow entry ("Bash(ls:*)") is PRESERVED;
//   - ~/.claude.json projects[root].enabledMcpjsonServers includes blender;
//   - a DISABLED user server is NOT granted (reconciled out of both gates).
// Run: node test/claudeMcpAllowList.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME so we never touch the real ~/.claude / ~/.claude.json.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcpallow-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { ConfigManager } = await import('../out/configManager.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcpallow-')));
  // Seed .mcp.json with a user/creative server (blender, enabled) and a disabled one.
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      blender: { command: 'uvx', args: ['blender-mcp'], _meta: { kind: 'user', name: 'blender' } },
      gimp:    { command: 'uvx', args: ['gimp-mcp'], enabled: false, _meta: { kind: 'user', name: 'gimp' } },
    },
  }, null, 2));
  // Seed a pre-existing NON-mcp allow rule that must survive.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(ls:*)', 'mcp__blender'] },
  }, null, 2));
  return root;
}

const readAllow = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).permissions.allow;
const readEnabled = (root) => {
  const dot = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
  return dot.projects[root].enabledMcpjsonServers;
};

console.log('claude MCP allow-list smoke');

const root = workspace();
console.log('  allow BEFORE:', JSON.stringify(readAllow(root)));
ConfigManager.syncProjectMcpServers(root);
const allow = readAllow(root);
const enabled = readEnabled(root);
console.log('  allow AFTER :', JSON.stringify(allow));
console.log('  enabledMcpjsonServers:', JSON.stringify(enabled));

ok('blender (user/creative) is granted mcp__blender in the allow list', () => {
  assert.ok(allow.includes('mcp__blender'), 'mcp__blender present — no longer silently omitted');
});

ok('the built-in MCP servers are granted too', () => {
  for (const b of ['mcp__memory', 'mcp__playwright', 'mcp__sequential-thinking', 'mcp__computer-use-mcp']) {
    assert.ok(allow.includes(b), `${b} present`);
  }
});

ok('a pre-existing NON-mcp allow entry is preserved (merge, not clobber)', () => {
  assert.ok(allow.includes('Bash(ls:*)'), 'Bash(ls:*) survived the reconcile');
});

ok('a disabled user server is NOT granted', () => {
  assert.ok(!allow.includes('mcp__gimp'), 'disabled gimp is reconciled out of the allow list');
});

ok('enabledMcpjsonServers (the loading gate) includes blender + built-ins, not the disabled one', () => {
  assert.ok(enabled.includes('blender'), 'blender is enabled for loading');
  assert.ok(enabled.includes('memory'), 'a built-in is enabled for loading');
  assert.ok(!enabled.includes('gimp'), 'disabled gimp not enabled for loading');
});

console.log(`\n${pass} checks passed`);
