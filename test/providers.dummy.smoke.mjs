// Offline smoke — dummy agent provider.
//
// Covers command parsing, realistic tool traces (factory-shaped), dispatch
// writing hooks-events.jsonl + stdout/exit, and session persistence. No
// network. Run: node test/providers.dummy.smoke.mjs  (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dummyProvider } from '../out/providers/dummy/ProviderManager.js';
import { parseDummyCommand, extractUserText } from '../out/providers/dummy/commands.js';
import { generateDummyTurn } from '../out/providers/dummy/traces.js';
import { DispatchRequestFactory } from '../out/providers/base/factories.js';
import { providerRegistry } from '../out/providers/base/ProviderRegistry.js';
import { PROVIDERS } from '../out/providers.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('dummy provider smoke');

ok('parseDummyCommand: hello / list / read / write / bash / todo / complete / lifecycle', () => {
  assert.strictEqual(parseDummyCommand('hello there').kind, 'hello');
  assert.strictEqual(parseDummyCommand('please list files').kind, 'list');
  assert.strictEqual(parseDummyCommand('read TODO.md').kind, 'read');
  assert.strictEqual(parseDummyCommand('read TODO.md').arg, 'TODO.md');
  assert.strictEqual(parseDummyCommand('write notes.md').kind, 'write');
  assert.strictEqual(parseDummyCommand('bash `ls -la`').kind, 'bash');
  assert.strictEqual(parseDummyCommand('update the todo list').kind, 'todo');
  assert.strictEqual(parseDummyCommand('complete the first task').kind, 'complete');
  assert.strictEqual(parseDummyCommand('Build a sample todo app with add/complete/delete').kind, 'lifecycle');
});

ok('extractUserText prefers the message half of a combined file', () => {
  const t = extractUserText('Do the thing\n\n---\n\n# PROFILE\nYou are an agent.');
  assert.ok(t.startsWith('Do the thing'));
  assert.ok(!t.includes('# PROFILE'));
});

ok('generateDummyTurn hello emits SessionStart + Notification + Stop', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-dturn-'));
  const turn = generateDummyTurn(root, { kind: 'hello', raw: 'hello' }, 'sess-1');
  const names = turn.events.map(e => e.hook_event_name);
  assert.ok(names.includes('SessionStart'));
  assert.ok(names.includes('Notification') || names.includes('AgentMessage'));
  assert.ok(names.includes('Stop'));
  assert.ok(turn.stdout.toLowerCase().includes('hello'));
  assert.ok(turn.events.every(e => e.provider === 'dummy'));
});

ok('generateDummyTurn lifecycle produces tool_start/tool_end pairs (realistic traces)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-dlife-'));
  const turn = generateDummyTurn(root, { kind: 'lifecycle', raw: 'Build a sample todo app' }, 'sess-2');
  const starts = turn.events.filter(e => e.hook_event_name === 'PreToolUse');
  const ends = turn.events.filter(e => e.hook_event_name === 'PostToolUse');
  assert.ok(starts.length >= 3, `expected several tool starts, got ${starts.length}`);
  assert.strictEqual(starts.length, ends.length, 'every tool start has an end');
  assert.ok(starts.some(e => e.tool_name === 'list_dir' || e.tool_name === 'read_file' || e.tool_name === 'Write'));
  assert.ok(turn.events.some(e => e.hook_event_name === 'TaskCreated'));
});

ok('generateDummyTurn list actually reads the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-dlist-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# hi', 'utf8');
  const turn = generateDummyTurn(root, { kind: 'list', raw: 'list files' }, 'sess-3');
  assert.ok(turn.stdout.includes('README.md'), turn.stdout);
});

ok('dispatch writes stdout, exit 0, and hooks-events.jsonl', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-ddisp-'));
  fs.mkdirSync(path.join(root, '.autodev', 'messages'), { recursive: true });
  const combined = path.join(root, '.autodev', 'messages', 'temp.md');
  const stdout = path.join(root, 'out.log');
  const exit = path.join(root, 'exit.code');
  fs.writeFileSync(combined, 'hello dummy', 'utf8');
  const req = DispatchRequestFactory.make({ root, combinedFile: combined, stdoutFile: stdout, exitFile: exit });
  const out = await dummyProvider.dispatch(req, DispatchRequestFactory.context());
  assert.deepStrictEqual(out, {});
  assert.strictEqual(fs.readFileSync(exit, 'utf8').trim(), '0');
  assert.ok(fs.readFileSync(stdout, 'utf8').toLowerCase().includes('hello'));
  const hooks = fs.readFileSync(path.join(root, '.autodev', 'hooks-events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(hooks.length >= 3);
  const parsed = hooks.map(l => JSON.parse(l));
  assert.ok(parsed.every(e => e.provider === 'dummy'));
  assert.ok(parsed.some(e => e.event_type === 'session_start'));
});

ok('dispatch complete checks off the first TODO item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-dtodo-'));
  fs.mkdirSync(path.join(root, '.autodev', 'messages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'TODO.md'), '# TODO\n\n## Todo\n\n- [ ] First task\n- [ ] Second\n', 'utf8');
  const combined = path.join(root, '.autodev', 'messages', 'temp.md');
  fs.writeFileSync(combined, 'complete the first task', 'utf8');
  const req = DispatchRequestFactory.make({
    root, combinedFile: combined,
    stdoutFile: path.join(root, 'out.log'),
    exitFile: path.join(root, 'exit.code'),
  });
  await dummyProvider.dispatch(req, DispatchRequestFactory.context());
  const todo = fs.readFileSync(path.join(root, 'TODO.md'), 'utf8');
  assert.ok(todo.includes('- [x] First task'), todo);
  assert.ok(todo.includes('- [ ] Second'));
});

ok('registry + PROVIDERS include dummy', () => {
  assert.ok(providerRegistry.has('dummy'));
  assert.strictEqual(PROVIDERS.dummy.label, 'Dummy Agent');
  assert.strictEqual(PROVIDERS.dummy.isCli, true);
});

ok('dummy is not busy after a finished dispatch', () => {
  assert.strictEqual(dummyProvider.isBusy('/no-such-root'), false);
});

console.log(`\n✅ dummy provider smoke: ${pass} checks passed`);
