// Unit smoke for the shared, provider-agnostic AcpSession (../providers/acp/
// AcpSession) + the grok/opencode launch specs. Drives a REAL AcpSession against
// a fake ACP agent (test/fixtures/fakeAcpAgent.mjs) — no model, fully offline.
//
// Covers the two correctness invariants fixed in 1.4.191:
//   BUG A — a mid-run steer is a LOOP-TRACKED continuation: isBusy() stays true
//           until the steered (queued) prompt also drains, and its hooks are
//           forwarded.
//   BUG B — a tool_call with no terminal update is FLUSHED to an end hook on turn
//           end (nothing left "running").
//
// Run: node test/acpSession.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');
const { GROK_ACP_SPEC } = await import('../out/providers/grok/GrokAcpSession.js');
const { OPENCODE_ACP_SPEC, opencodeAcpEnabled, __setOpencodeAcpEnabledForTest } =
  await import('../out/providers/opencode/acp.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(10); } return false; }

console.log('acpSession: shared ACP client + launch specs');

// --- launch specs ---------------------------------------------------------
ok('grok spec: parent opts before stdio, model injected', () => {
  assert.deepEqual(GROK_ACP_SPEC.buildArgs('grok-code', []), ['agent', '--always-approve', '-m', 'grok-code', '--no-leader', 'stdio']);
  assert.deepEqual(GROK_ACP_SPEC.buildArgs(undefined, []), ['agent', '--always-approve', '--no-leader', 'stdio']);
});
ok('opencode spec: `acp` only (model injected via OPENCODE_CONFIG, not -m)', () => {
  assert.deepEqual(OPENCODE_ACP_SPEC.buildArgs('ollama-cloud/gpt-oss:20b', []), ['acp']);
  assert.deepEqual(OPENCODE_ACP_SPEC.buildArgs(undefined, []), ['acp']);
});

// --- decoder additions ----------------------------------------------------
ok('decode: agent_thought_chunk → reasoning', () => {
  const d = decodeAcpUpdateStandard({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } } });
  assert.equal(d.kind, 'reasoning');
  assert.equal(d.text, 'hmm');
});
ok('decode: tool_call_update cancelled → tool_result(cancelled)', () => {
  const d = decodeAcpUpdateStandard({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'cancelled' } } });
  assert.equal(d.kind, 'tool_result');
  assert.equal(d.status, 'cancelled');
});

// --- opencode enablement gate --------------------------------------------
ok('opencodeAcpEnabled: env off-switch honoured', () => {
  __setOpencodeAcpEnabledForTest(null);
  assert.equal(opencodeAcpEnabled({ AUTODEV_OPENCODE_ACP: 'off' }), false);
  assert.equal(opencodeAcpEnabled({ AUTODEV_OPENCODE_ACP: '0' }), false);
  __setOpencodeAcpEnabledForTest(true);
  assert.equal(opencodeAcpEnabled({}), true);
  __setOpencodeAcpEnabledForTest(null);
});

// helper: build an AcpSession wired to the fake agent, collecting hook events.
function makeSession(initialSessionId) {
  const events = [];
  const spec = { buildArgs: () => [FAKE], narrationTitle: 'test', decodeUpdate: decodeAcpUpdateStandard };
  const sess = new AcpSession({
    root: process.cwd(), bin: process.execPath, spec, initialSessionId,
    hooks: { emitHook: (name, extra) => events.push({ name, extra }), log: () => {} },
  });
  return { sess, events };
}

// --- LAYER A.1: session/load replay is QUIET (zero hooks) ------------------
await okAsync('A.1: session/load replay emits ZERO hooks (quiet reload)', async () => {
  const { sess, events } = makeSession('prior-session-id'); // triggers session/load
  await sess.ensureReady(); // replay happens here
  const replaySpam = events.filter(e => e.name === 'Notification' || e.name === 'PreToolUse' || e.name === 'PostToolUse');
  assert.equal(replaySpam.length, 0, 'no narration/tool hooks from the replay');
  // A real turn AFTER load still forwards hooks normally.
  await sess.runTurn('now do real work', () => {});
  assert.ok(events.some(e => e.name === 'Notification' && String(e.extra.message).includes('now do real work')), 'post-load turn narrates');
  sess.close();
});

// --- LAYER A.3: per-turn watchdog cancels + fails truthfully ---------------
ok('A.3: maxRunMs honours env override + defaults to 20m', () => {
  process.env.AUTODEV_ACP_MAX_RUN_MS = '150';
  assert.equal(AcpSession.maxRunMs(), 150);
  delete process.env.AUTODEV_ACP_MAX_RUN_MS;
  assert.equal(AcpSession.maxRunMs(), 20 * 60 * 1000, 'default 20m when unset');
});
await okAsync('A.3: a wedged turn hits the watchdog → clean=false stopReason=timeout, tool flushed', async () => {
  process.env.AUTODEV_ACP_MAX_RUN_MS = '400'; // tiny budget
  const { sess, events } = makeSession();
  const res = await sess.runTurn('please HANG forever', () => {});
  assert.equal(res.clean, false, 'wedged turn is NOT a false success');
  assert.equal(res.stopReason, 'timeout');
  // The tool opened by the hung turn must not be left "running".
  const dangling = events.filter(e => e.name === 'PreToolUse' && e.extra.tool_use_id === 'tc-hang')
    .filter(pre => !events.some(end => /PostToolUse/.test(end.name) && end.extra.tool_use_id === 'tc-hang'));
  assert.equal(dangling.length, 0, 'hung tool flushed to an end hook');
  assert.equal(events.filter(e => e.name === 'StopFailure').length >= 1, true, 'surfaced as StopFailure');
  delete process.env.AUTODEV_ACP_MAX_RUN_MS;
  sess.close();
});

// --- BUG A: a mid-run steer is tracked; isBusy stays true through drain -----
await okAsync('BUG A: steer keeps isBusy=true until the queued turn drains; hooks forwarded', async () => {
  const { sess, events } = makeSession();
  const sink = [];
  const turn = sess.runTurn('primary hello', (t) => sink.push(t));
  assert.ok(await waitFor(() => sess.isBusy()), 'busy once the primary turn starts');
  const steered = sess.steer('STEERED continuation');
  assert.equal(steered, true, 'steer accepted by live session');
  // While the primary is still resolving and the steer is queued, we must remain busy.
  assert.equal(sess.isBusy(), true, 'busy with a queued steer');
  const res = await turn; // resolves only after BOTH prompts drain (Bug A)
  assert.equal(res.clean, true);
  assert.equal(sess.isBusy(), false, 'idle only after full drain');
  const narrated = events.filter(e => e.name === 'Notification').map(e => String(e.extra.message));
  assert.ok(narrated.some(m => m.includes('primary hello')), 'primary narration forwarded');
  assert.ok(narrated.some(m => m.includes('STEERED continuation')), 'steered turn narration forwarded');
  const stops = events.filter(e => e.name === 'Stop');
  assert.equal(stops.length, 1, 'exactly one Stop after the queue drains');
  sess.close();
});

// --- BUG B: an open tool_call is flushed to an end hook on turn end ---------
await okAsync('BUG B: tool_call with no terminal update is flushed to a PostToolUse end', async () => {
  const { sess, events } = makeSession();
  const res = await sess.runTurn('do OPENTOOL now', () => {});
  assert.equal(res.clean, true);
  const pre = events.filter(e => e.name === 'PreToolUse');
  assert.equal(pre.length, 1, 'one tool start');
  assert.equal(pre[0].extra.tool_name, 'edit');
  // No terminal tool_call_update was sent by the fake → the session must flush it.
  const ends = events.filter(e => (e.name === 'PostToolUse' || e.name === 'PostToolUseFailure') && e.extra.tool_use_id === 'tc-open');
  assert.equal(ends.length, 1, 'the open tool_call was flushed to exactly one end hook');
  assert.equal(ends[0].name, 'PostToolUseFailure');
  assert.equal(ends[0].extra.outcome, 'interrupted');
  assert.equal(sess.activity, undefined, 'no dangling activity');
  sess.close();
});

// --- a properly-closed tool_call is NOT double-ended -----------------------
await okAsync('a terminal tool_call_update pairs start→end once (no flush duplicate)', async () => {
  const { sess, events } = makeSession();
  await sess.runTurn('do CLOSETOOL please', () => {});
  const ends = events.filter(e => (e.name === 'PostToolUse' || e.name === 'PostToolUseFailure') && e.extra.tool_use_id === 'tc-closed');
  assert.equal(ends.length, 1, 'exactly one end for a normally-closed tool');
  assert.equal(ends[0].name, 'PostToolUse');
  sess.close();
});

console.log(`\nacpSession: ${pass} checks passed`);
