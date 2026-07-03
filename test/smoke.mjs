// Lightweight smoke tests (no framework) — guard the SOLID provider layer +
// core parsing against regressions. Run: node test/smoke.mjs (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerRegistry } from '../out/core/provider/ProviderRegistry.js';
import { parseTodoContent, countRemaining } from '../out/todo.js';
import { replaceProjectBuiltinMcp, saveProjectUserMcp, loadProjectAllMcp, isRemoteMcp } from '../out/core/projectMcp.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// Registry resolves every provider id with the right kind.
const expected = {
  'claude-cli': 'cli', 'copilot-cli': 'cli', 'opencode-cli': 'cli',
  'claude-tui': 'tui', 'grok-tui': 'tui', 'copilot-sdk': 'sdk', 'opencode-sdk': 'sdk',
};
ok('registry has all 7 providers', () => assert.equal(providerRegistry.ids().length, 7));
for (const [id, kind] of Object.entries(expected)) {
  ok(`registry resolves ${id} (kind=${kind})`, () => {
    const p = providerRegistry.get(id);
    assert.equal(p.id, id); assert.equal(p.kind, kind);
    assert.equal(typeof p.dispatch, 'function');
  });
}
ok('unknown provider throws', () => assert.throws(() => providerRegistry.get('nope')));

// CLI provider builds a non-empty shell command from a DispatchRequest.
ok('opencode-cli builds a command', async () => {
  const req = { root: '/tmp/x', agentProfileFile: '/tmp/x/p.md', messageFile: '/tmp/x/m.md',
    combinedFile: '/tmp/x/c.md', includeProfile: true, settings: { opencodeModel: 'm', hooksEnabled: false },
    stdoutFile: '/tmp/x/o.txt', exitFile: '/tmp/x/e.txt' };
  const out = await providerRegistry.get('opencode-cli').dispatch(req, { log: () => {}, launcher: { launch() {} } });
  assert.ok(out.command && out.command.includes('opencode run'), 'command should run opencode');
});

// todo parsing.
ok('parseTodoContent + countRemaining', () => {
  const tasks = parseTodoContent('# TODO\n\n- [ ] a\n- [~] b\n- [x] 2026-01-01  c\n');
  assert.equal(tasks.length, 3);
  assert.equal(countRemaining(tasks), 2); // [ ] + [~]
});

// .mcp.json preserves remote (http/sse) entries alongside stdio ones.
ok('projectMcp preserves remote (http) builtin entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcp-'));
  try {
    replaceProjectBuiltinMcp(root, {
      'pixel-office': { type: 'http', url: 'https://h/api/mcp', headers: { Authorization: 'Bearer agt_x' } },
      'memory': { command: 'npx', args: ['-y', 'server-memory'] },
    });
    const all = loadProjectAllMcp(root);
    assert.ok(isRemoteMcp(all['pixel-office']), 'pixel-office should be remote');
    assert.equal(all['pixel-office'].url, 'https://h/api/mcp');
    assert.equal(all['pixel-office'].headers.Authorization, 'Bearer agt_x');
    assert.ok(!('command' in all['pixel-office']), 'remote entry has no command');
    assert.equal(all['memory'].command, 'npx');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Malformed user entries (neither command nor url) are dropped, not written broken.
ok('projectMcp drops malformed user entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcp-'));
  try {
    saveProjectUserMcp(root, {
      bogus: { args: ['x'] },              // no command, no url → dropped
      good:  { command: 'node' },
      rem:   { url: 'https://h/mcp' },     // remote → kept
    });
    const all = loadProjectAllMcp(root);
    assert.ok(!('bogus' in all), 'malformed entry should be dropped');
    assert.equal(all['good'].command, 'node');
    assert.ok(isRemoteMcp(all['rem']), 'url-only entry kept as remote');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
