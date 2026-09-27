// Offline smoke — provider service-oriented layer.
//
// Locks the per-family service classes (Events / Models / Sessions / State /
// Normalizer / Usage / Manager) and the factory generation helpers that
// produce mocks from the same shapes as pixel-office HookPayloadFactory.
//
// Run: node test/providers.services.smoke.mjs  (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { providerRegistry } from '../out/providers/base/ProviderRegistry.js';
import { HookEventFactory, DispatchRequestFactory, SessionFactory, UsageFactory, ModelFactory } from '../out/providers/base/factories.js';
import { eventTypeFor, normalizeEvent } from '../out/providers/base/ProviderNormalizer.js';
import { ClaudeProviderEvents } from '../out/providers/claude/ProviderEvents.js';
import { ClaudeProviderModels } from '../out/providers/claude/ProviderModels.js';
import { ClaudeProviderUsage, extractClaudeUsage } from '../out/providers/claude/ProviderUsage.js';
import { ClaudeProviderSessions } from '../out/providers/claude/ProviderSessions.js';
import { ClaudeCliProviderState } from '../out/providers/claude/ProviderState.js';
import { __setClaudeCliPersistentForTest } from '../out/providers/claude/tui.js';
import { ClaudeProviderNormalizer } from '../out/providers/claude/ProviderNormalizer.js';
import { CopilotProviderEvents } from '../out/providers/copilot/ProviderEvents.js';
import { CopilotProviderModels } from '../out/providers/copilot/ProviderModels.js';
import { CopilotProviderUsage, extractCopilotUsage } from '../out/providers/copilot/ProviderUsage.js';
import { CopilotProviderSessions } from '../out/providers/copilot/ProviderSessions.js';
import { GrokProviderEvents } from '../out/providers/grok/ProviderEvents.js';
import { GrokProviderModels } from '../out/providers/grok/ProviderModels.js';
import { GrokProviderUsage } from '../out/providers/grok/ProviderUsage.js';
import { GrokProviderSessions } from '../out/providers/grok/ProviderSessions.js';
import { OpencodeProviderEvents } from '../out/providers/opencode/ProviderEvents.js';
import { OpencodeProviderModels } from '../out/providers/opencode/ProviderModels.js';
import { OpencodeProviderUsage } from '../out/providers/opencode/ProviderUsage.js';
import { DummyProviderEvents } from '../out/providers/dummy/ProviderEvents.js';
import { DummyProviderModels } from '../out/providers/dummy/ProviderModels.js';
import { DummyProviderUsage } from '../out/providers/dummy/ProviderUsage.js';
import { DummyProviderSessions } from '../out/providers/dummy/ProviderSessions.js';
import { DummyProviderState } from '../out/providers/dummy/ProviderState.js';
import { DummyProviderNormalizer } from '../out/providers/dummy/ProviderNormalizer.js';
import { friendlyModelName } from '../out/providers/base/ProviderModels.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('provider services / factories smoke');

const FAMILIES = [
  { name: 'claude', events: new ClaudeProviderEvents(), models: new ClaudeProviderModels(), usage: new ClaudeProviderUsage() },
  { name: 'copilot', events: new CopilotProviderEvents(), models: new CopilotProviderModels(), usage: new CopilotProviderUsage() },
  { name: 'grok', events: new GrokProviderEvents(), models: new GrokProviderModels(), usage: new GrokProviderUsage() },
  { name: 'opencode', events: new OpencodeProviderEvents(), models: new OpencodeProviderModels(), usage: new OpencodeProviderUsage() },
  { name: 'dummy', events: new DummyProviderEvents(), models: new DummyProviderModels(), usage: new DummyProviderUsage() },
];

for (const f of FAMILIES) {
  ok(`${f.name}: events listSupported includes PreToolUse + SessionStart`, () => {
    const names = f.events.listSupported();
    assert.ok(names.includes('PreToolUse'), `${f.name} emits PreToolUse`);
    assert.ok(names.includes('SessionStart'), `${f.name} emits SessionStart`);
  });
  ok(`${f.name}: models catalog is non-empty and resolve() works`, () => {
    const list = f.models.list();
    assert.ok(list.length > 0);
    assert.ok(list.every(m => m.id && m.label && m.contextLimit > 0));
    assert.strictEqual(f.models.resolve(list[0].id)?.id, list[0].id);
    assert.ok(f.models.contextLimit(list[0].id) > 0);
  });
}

ok('factory: HookEventFactory.todoAppLifecycle emits canonical event_types', () => {
  for (const provider of ['claude-cli', 'grok-tui', 'opencode-sdk', 'copilot-cli', 'dummy']) {
    const seq = HookEventFactory.make({ provider }).todoAppLifecycle();
    assert.ok(seq.length >= 10, `${provider} lifecycle is a full turn`);
    assert.strictEqual(seq[0].event_type, 'session_start');
    assert.ok(seq.some(e => e.event_type === 'tool_start'));
    assert.ok(seq.some(e => e.event_type === 'tool_end'));
    assert.ok(seq.some(e => e.hook_event_name === 'SessionEnd'));
    assert.ok(seq.every(e => e.provider === provider));
    assert.ok(seq.every(e => e.timestamp));
  }
});

ok('factory: toolStart/toolEnd pair shares tool_use_id and maps via normalizeEvent', () => {
  const f = HookEventFactory.make({ provider: 'claude-cli' });
  const start = f.toolStart('Read', { file_path: '/ws/a.ts' }, 'call-1');
  const end = f.toolEnd('Read', { file_path: '/ws/a.ts', output: 'ok' }, 'call-1');
  assert.strictEqual(start.tool_use_id, 'call-1');
  assert.strictEqual(end.tool_use_id, 'call-1');
  const nStart = normalizeEvent('claude-cli', start);
  const nEnd = normalizeEvent('claude-cli', end);
  assert.strictEqual(nStart.event_type, 'tool_start');
  assert.strictEqual(nEnd.event_type, 'tool_end');
  assert.strictEqual(nStart.tool_name, 'Read');
});

ok('factory: DispatchRequestFactory + SessionFactory + UsageFactory + ModelFactory', () => {
  const req = DispatchRequestFactory.make({ root: '/tmp/ws' });
  assert.strictEqual(req.root, '/tmp/ws');
  assert.ok(req.agentProfileFile.endsWith('AGENT_PROFILE.md'));
  const ctx = DispatchRequestFactory.context();
  assert.strictEqual(typeof ctx.log, 'function');
  const sess = SessionFactory.record({ id: 's1' });
  assert.strictEqual(sess.id, 's1');
  const msgs = SessionFactory.transcript();
  assert.ok(msgs.some(m => m.role === 'user'));
  const usage = UsageFactory.make({ contextTokens: 40_000 });
  assert.strictEqual(usage.contextTokens, 40_000);
  const model = ModelFactory.make({ id: 'x' });
  assert.strictEqual(model.id, 'x');
});

ok('claude usage: factory block → 20% of 200k', () => {
  const block = UsageFactory.claudeBlock();
  const usage = extractClaudeUsage(block, 'claude-opus-4-8');
  assert.equal(usage.contextTokens, 40_000);
  assert.equal(usage.contextPct, 20);
  assert.equal(usage.tokens, 6200);
});

ok('copilot usage: factory block extracts tokens', () => {
  const usage = extractCopilotUsage(UsageFactory.copilotBlock());
  assert.equal(usage.inputTokens, 4200);
  assert.equal(usage.outputTokens, 800);
  assert.ok(usage.contextPct > 0);
});

ok('dummy usage: synthesize from prompt length', () => {
  const usage = new DummyProviderUsage().synthesize(400);
  assert.ok(usage.inputTokens >= 80);
  assert.ok(usage.outputTokens > 0);
  assert.ok(usage.contextPct >= 0 && usage.contextPct <= 100);
});

ok('claude/cli manager dispatch still builds a claude command (persistent off)', async () => {
  // Phase 2 defaults claude-cli to the persistent claude-tui client; force OFF
  // to assert the legacy per-turn command builder is intact for fallback.
  __setClaudeCliPersistentForTest(false);
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-svc-'));
    const req = DispatchRequestFactory.make({ root, settings: { hooksEnabled: false, claudeModel: 'sonnet' } });
    const out = await providerRegistry.get('claude-cli').dispatch(req, DispatchRequestFactory.context());
    assert.ok(out.command.includes('claude '));
    assert.ok(out.command.includes('--model sonnet'));
  } finally { __setClaudeCliPersistentForTest(null); }
});

ok('dummy manager is registered as sdk and has service objects', () => {
  const p = providerRegistry.get('dummy');
  assert.strictEqual(p.id, 'dummy');
  assert.strictEqual(p.kind, 'sdk');
  assert.strictEqual(p.label, 'Dummy Agent');
  assert.ok(p.events && p.models && p.sessions && p.state && p.normalizer && p.usage);
});

ok('dummy sessions persist + read transcript via factory-like records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-dsess-'));
  const sessions = new DummyProviderSessions();
  const rec = sessions.create(root, 'office-test');
  sessions.appendMessages(root, rec.id, SessionFactory.transcript({ user: 'hello' }));
  const listed = sessions.list(root);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, 'office-test');
  const msgs = sessions.readTranscript(rec.id, { cwd: root });
  assert.ok(msgs.some(m => m.text === 'hello'));
});

ok('dummy state busy/idle', () => {
  const st = new DummyProviderState();
  const root = '/tmp/dummy-state';
  assert.strictEqual(st.isBusy(root), false);
  st.markBusy(root);
  assert.strictEqual(st.isBusy(root), true);
  st.markIdle(root);
  assert.strictEqual(st.isBusy(root), false);
});

ok('dummy events emit writes hooks-events.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-devt-'));
  const ev = new DummyProviderEvents();
  ev.emit(root, 'SessionStart', { source: 'startup' });
  const all = ev.readAll(root);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].event_type, 'session_start');
  assert.strictEqual(all[0].provider, 'dummy');
});

ok('normalizers wrap the shared normalizeEvent path', () => {
  const raw = HookEventFactory.make({ provider: 'dummy' }).sessionStart();
  const n = new DummyProviderNormalizer().normalize(raw);
  assert.strictEqual(n.event_type, 'session_start');
  const c = new ClaudeProviderNormalizer().normalize(raw);
  assert.strictEqual(c.hook_event_name, 'SessionStart');
});

ok('friendlyModelName still resolves claude aliases (moved into ProviderModels)', () => {
  assert.strictEqual(friendlyModelName('claude-opus-4-8'), 'Opus 4.8');
  assert.strictEqual(friendlyModelName('anthropic/claude-sonnet-4-5'), 'Sonnet 4.5');
});

ok('eventTypeFor map is unchanged for the office chat kinds', () => {
  assert.strictEqual(eventTypeFor('PreToolUse'), 'tool_start');
  assert.strictEqual(eventTypeFor('PostToolUse'), 'tool_end');
  assert.strictEqual(eventTypeFor('Notification'), 'notification');
});

ok('cli-state defaults stay idle (Liskov)', () => {
  const st = new ClaudeCliProviderState();
  assert.strictEqual(st.isBusy('/x'), false);
  st.close('/x', () => {});
});

console.log(`\n✅ provider services smoke: ${pass} checks passed`);
