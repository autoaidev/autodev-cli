// Lightweight smoke tests (no framework) — guard the SOLID provider layer +
// core parsing against regressions. Run: node test/smoke.mjs (after npm run build).
import assert from 'node:assert';
import { providerRegistry } from '../out/core/provider/ProviderRegistry.js';
import { parseTodoContent, countRemaining } from '../out/todo.js';

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

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
