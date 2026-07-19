// Smoke — CliExitHandler must tell a provider HARD-FAILURE apart from a
// ran-but-unmarked completion, so a provider outage is reported failed/blocked
// instead of being auto-marked [x] done (false green in the office).
//
// Drives CliExitHandler.decide() directly with crafted TODO.md + hooks-events
// state — no live provider needed. Run: node test/cliExitHardFail.smoke.mjs
// (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliExitHandler } from '../out/cliExit.js';
import { parseTodo } from '../out/todo.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('cliExit hard-fail smoke');

// --- helpers ---------------------------------------------------------------
function mkWorkspace(todoLine, hookEvents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hardfail-'));
  fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
  const todoPath = path.join(root, 'TODO.md');
  fs.writeFileSync(todoPath, `# TODO\n\n${todoLine}\n`, 'utf8');
  if (hookEvents && hookEvents.length) {
    const jsonl = hookEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(root, '.autodev', 'hooks-events.jsonl'), jsonl, 'utf8');
  }
  return { root, todoPath };
}

// taskStartTime = 10s ago; all crafted hook events are "now" (after start).
const START = Date.now() - 10_000;
const nowIso = () => new Date().toISOString();
const ev = (name, extra = {}) => ({ hook_event_name: name, timestamp: nowIso(), ...extra });

function makeHandler(todoLine, hookEvents, { done = false } = {}) {
  const { root, todoPath } = mkWorkspace(todoLine, hookEvents);
  const task = parseTodo(todoPath)[0];
  const handler = new CliExitHandler(root, todoPath, task, START, () => done);
  return { handler, root, todoPath, task };
}

// A [ ] task with no signals, dispatched twice, is the legit ran-but-unmarked
// case → first exit reminds, second exit gives up (auto-mark). Used as the
// control so we know decide()'s reminder gate still works.
ok('normal ran-unmarked: reminder then give_up (still auto-marks)', () => {
  const events = [ev('AgentMessage', { text: 'did the work' }), ev('SessionEnd', { reason: 'completed' })];
  const { handler } = makeHandler('- [ ] write the readme', events);
  const first = handler.decide({ exitedNonZero: false, stdoutError: null });
  assert.equal(first.kind, 'remind', 'first exit should remind');
  const second = handler.decide({ exitedNonZero: false, stdoutError: null });
  assert.equal(second.kind, 'give_up', 'second clean exit should give_up (auto-mark done)');
});

ok('task already [x] → done (never touches hooks)', () => {
  const { handler } = makeHandler('- [x] 2026-01-01 done task', [ev('SessionEnd', { reason: 'reauth_required' })], { done: true });
  assert.equal(handler.decide({ exitedNonZero: true }).kind, 'done');
});

ok('deferred [~] with clean exit → deferred (agent-intended)', () => {
  const events = [ev('AgentMessage', { text: 'left in progress on purpose' }), ev('Stop', {})];
  const { handler } = makeHandler('- [~] waiting on external reply', events);
  assert.equal(handler.decide({ exitedNonZero: false, stdoutError: null }).kind, 'deferred');
});

// --- HARD FAILURES: must NOT give_up / auto-mark --------------------------
ok('reauth_required (SessionEnd reason) → hard_fail on FIRST exit', () => {
  const events = [ev('StopFailure', { exit_code: 1 }), ev('SessionEnd', { reason: 'reauth_required' })];
  const { handler } = makeHandler('- [ ] ship the feature', events);
  const d = handler.decide({ exitedNonZero: true, stdoutError: null });
  assert.equal(d.kind, 'hard_fail');
  assert.equal(d.reason, 'reauth_required');
});

ok('reauth_required custom hook event → hard_fail', () => {
  const events = [ev('reauth_required', { message: 'token expired' })];
  const { handler } = makeHandler('- [ ] ship the feature', events);
  assert.equal(handler.decide({ exitedNonZero: true }).reason, 'reauth_required');
});

ok('grok session-exit → hard_fail', () => {
  const events = [ev('StopFailure', { exit_code: 1 }), ev('SessionEnd', { reason: 'session-exit' })];
  const { handler } = makeHandler('- [ ] build the thing', events);
  assert.equal(handler.decide({ exitedNonZero: true }).reason, 'session-exit');
});

ok('grok launch-failed → hard_fail', () => {
  const events = [ev('SessionEnd', { reason: 'launch-failed' })];
  const { handler } = makeHandler('- [ ] build the thing', events);
  assert.equal(handler.decide({ exitedNonZero: true }).reason, 'launch-failed');
});

ok('opencode session.error (exit 0 + [ERROR] stdout sentinel) → hard_fail', () => {
  // No failure hook at all; only the stdout sentinel + exit 0.
  const events = [ev('SessionStart', { source: 'startup' })];
  const { handler } = makeHandler('- [ ] refactor module', events);
  const d = handler.decide({ exitedNonZero: false, stdoutError: 'session-error' });
  assert.equal(d.kind, 'hard_fail');
  assert.equal(d.reason, 'session-error');
});

ok('non-zero exit with no work this turn → hard_fail (exit_nonzero)', () => {
  const events = [ev('SessionStart', { source: 'startup' })]; // no AgentMessage/tool events
  const { handler } = makeHandler('- [ ] do the task', events);
  const d = handler.decide({ exitedNonZero: true, stdoutError: null });
  assert.equal(d.kind, 'hard_fail');
  assert.equal(d.reason, 'exit_nonzero');
});

ok('StopFailure hook (no specific SessionEnd reason) → hard_fail', () => {
  const events = [ev('StopFailure', { exit_code: 1 })];
  const { handler } = makeHandler('- [ ] do the task', events);
  assert.equal(handler.decide({ exitedNonZero: true }).reason, 'stop_failure');
});

ok('hard_fail even when the agent left a stray [~]', () => {
  const events = [ev('SessionEnd', { reason: 'reauth_required' })];
  const { handler } = makeHandler('- [~] half-started task', events);
  const d = handler.decide({ exitedNonZero: true });
  assert.equal(d.kind, 'hard_fail', 'a [~] left by an outage is blocked, not a clean defer');
});

// --- WATCHDOG nuance: kill WITH real work is ran-but-unmarked, not an outage
ok('watchdog WITH assistant work → NOT hard_fail (give_up path preserved)', () => {
  const events = [
    ev('PreToolUse', { tool_name: 'bash' }),
    ev('PostToolUse', { tool_name: 'bash' }),
    ev('AgentMessage', { text: 'made real progress' }),
    ev('StopFailure', { exit_code: 124 }),
    ev('SessionEnd', { reason: 'watchdog' }),
  ];
  const { handler } = makeHandler('- [ ] long task', events);
  const first = handler.decide({ exitedNonZero: true });     // watchdog+work → not hard-fail
  assert.equal(first.kind, 'remind', 'watchdog after real work stays on the reminder path');
  const second = handler.decide({ exitedNonZero: true });
  assert.equal(second.kind, 'give_up', 'and auto-marks on the second exit');
});

ok('watchdog with NO work → hard_fail', () => {
  const events = [ev('StopFailure', { exit_code: 124 }), ev('SessionEnd', { reason: 'watchdog' })];
  const { handler } = makeHandler('- [ ] stuck task', events);
  assert.equal(handler.decide({ exitedNonZero: true }).reason, 'watchdog');
});

// --- staleness guard: a hard-fail from BEFORE this task started is ignored --
ok('stale failure event before taskStartTime is ignored → not hard_fail', () => {
  const staleIso = new Date(START - 60_000).toISOString(); // a minute before start
  const events = [
    { hook_event_name: 'SessionEnd', reason: 'reauth_required', timestamp: staleIso },
    ev('AgentMessage', { text: 'fresh work this turn' }),
    ev('SessionEnd', { reason: 'completed' }),
  ];
  const { handler } = makeHandler('- [ ] fresh task', events);
  const first = handler.decide({ exitedNonZero: false, stdoutError: null });
  assert.equal(first.kind, 'remind', 'a stale pre-start failure must not taint this turn');
});

console.log(`\ncliExit hard-fail smoke: ${pass} passed`);
