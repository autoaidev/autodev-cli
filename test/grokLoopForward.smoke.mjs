// Offline smoke — the grok-tui LOOP forwarder mapping (../core/grokEvents
// grokLoopForwardHooks) + the HEADLESS turn-end signal (scanGrokTurnEnd).
//
// Covers the 1.4.177 loop fix: a grok-tui LOOP turn on a HEADLESS box (Windows,
// no tmux → sendGrokPrompt) used to forward ONLY Session*/Stop* boundaries — no
// tool calls, no narration — and never detect grok 4.7's turn-end, so a finished
// turn ran to the 10-min watchdog (false StopFailure→retry). The loop now tails
// grok's OWN session logs and maps them to the office hook feed via this PURE
// helper, and ends the turn PROMPTLY on a clean turn_ended.
//
// Asserts, from synthetic events.jsonl / chat_history.jsonl lines:
//   • tool_started read_file      → PreToolUse (tool_name + tool_use_id)
//   • tool_completed success      → PostToolUse
//   • tool_completed error        → PostToolUseFailure (outcome carried)
//   • an mcp__ / office tool       → SKIPPED (office logs it server-side)
//   • assistant chat_history line → Notification (narration)
//   • dedupe: the SAME tool_call id twice emits ONE PreToolUse
//   • a clean turn_ended stream classifies as a clean finish (Stop, not a kill)
// Run: node test/grokLoopForward.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { grokLoopForwardHooks, scanGrokTurnEnd } = await import('../out/core/grokEvents.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grokLoopForward: LOOP session-log → office hook mapping + headless turn-end');

// Real event lines shaped from a grok session events.jsonl dump.
const EV = {
  toolStartedRead:  '{"ts":"2026-07-25T11:14:02.282Z","type":"tool_started","tool_name":"read_file","tool_call_id":"call_1"}',
  toolCompletedOk:  '{"ts":"2026-07-25T11:14:02.900Z","type":"tool_completed","tool_name":"read_file","outcome":"success","tool_call_id":"call_1"}',
  toolStartedBash:  '{"ts":"2026-07-25T11:14:03.100Z","type":"tool_started","tool_name":"bash","tool_call_id":"call_2"}',
  toolCompletedErr: '{"ts":"2026-07-25T11:14:03.500Z","type":"tool_completed","tool_name":"bash","outcome":"error","tool_call_id":"call_2"}',
  toolStartedMcp:   '{"ts":"2026-07-25T11:14:04.000Z","type":"tool_started","tool_name":"mcp__office__send_message","tool_call_id":"call_3"}',
  toolStartedOffice:'{"ts":"2026-07-25T11:14:04.100Z","type":"tool_started","tool_name":"complete_task","tool_call_id":"call_4"}',
  turnEndedClean:   '{"ts":"2026-07-25T11:14:09.000Z","type":"turn_ended","outcome":"completed"}',
  turnEndedError:   '{"ts":"2026-07-25T11:14:09.000Z","type":"turn_ended","outcome":"aborted"}',
  phaseTool:        '{"ts":"2026-07-25T11:14:02.000Z","type":"phase_changed","phase":"tool_execution"}',
};
const CH = {
  assistant: '{"type":"assistant","content":"Reading the config and patching the bug."}',
  assistantBlocks: '{"role":"assistant","content":[{"type":"text","text":"Done — tests pass."}]}',
  user: '{"type":"user","content":"go"}',
  reasoning: '{"type":"reasoning","content":"think"}',
  toolResult: '{"type":"tool_result","tool_call_id":"call_1","content":"file bytes"}',
};

ok('tool_started native tool → PreToolUse with tool_name + tool_use_id', () => {
  const hooks = grokLoopForwardHooks([EV.toolStartedRead], [], new Set());
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].hook_event_name, 'PreToolUse');
  assert.equal(hooks[0].tool_name, 'read_file');
  assert.equal(hooks[0].tool_use_id, 'call_1');
});

ok('tool_completed success → PostToolUse', () => {
  const hooks = grokLoopForwardHooks([EV.toolCompletedOk], [], new Set());
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].hook_event_name, 'PostToolUse');
  assert.equal(hooks[0].tool_name, 'read_file');
  assert.equal(hooks[0].tool_use_id, 'call_1');
});

ok('tool_completed error → PostToolUseFailure (outcome carried)', () => {
  const hooks = grokLoopForwardHooks([EV.toolCompletedErr], [], new Set());
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].hook_event_name, 'PostToolUseFailure');
  assert.equal(hooks[0].tool_name, 'bash');
  assert.equal(hooks[0].outcome, 'error');
});

ok('mcp__ AND bare office tool are SKIPPED (logged server-side)', () => {
  const hooks = grokLoopForwardHooks([EV.toolStartedMcp, EV.toolStartedOffice], [], new Set());
  assert.equal(hooks.length, 0);
});

ok('phase_changed / non-tool events emit nothing', () => {
  const hooks = grokLoopForwardHooks([EV.phaseTool], [], new Set());
  assert.equal(hooks.length, 0);
});

ok('assistant chat_history line → Notification (string + block content)', () => {
  const hooks = grokLoopForwardHooks([], [CH.assistant, CH.assistantBlocks], new Set());
  assert.equal(hooks.length, 2);
  assert.ok(hooks.every(h => h.hook_event_name === 'Notification'));
  assert.match(hooks[0].message, /patching the bug/);
  assert.match(hooks[1].message, /tests pass/);
});

ok('non-assistant chat lines (user/reasoning/tool_result) → no narration', () => {
  const hooks = grokLoopForwardHooks([], [CH.user, CH.reasoning, CH.toolResult], new Set());
  assert.equal(hooks.length, 0);
});

ok('dedupe: same tool_call id across ticks emits ONE PreToolUse', () => {
  const seen = new Set();
  const a = grokLoopForwardHooks([EV.toolStartedRead], [], seen);
  const b = grokLoopForwardHooks([EV.toolStartedRead], [], seen); // re-observed → skip
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  assert.ok(seen.has('call_1'));
});

ok('mixed batch: native Pre/Post + narration, mcp skipped, in order', () => {
  const seen = new Set();
  const hooks = grokLoopForwardHooks(
    [EV.toolStartedRead, EV.toolStartedMcp, EV.toolCompletedOk],
    [CH.assistant],
    seen,
  );
  const names = hooks.map(h => h.hook_event_name);
  assert.deepEqual(names, ['PreToolUse', 'PostToolUse', 'Notification']);
});

// ── HEADLESS turn-end signal: the loop finishes on a clean turn_ended ─────────
ok('headless events stream with turn_ended completed → clean finish', () => {
  const stream = [EV.toolStartedRead, EV.toolCompletedOk, EV.turnEndedClean];
  assert.equal(scanGrokTurnEnd(stream), 'clean'); // → finishFromTurnEnd(true) = Stop, code 0
});

ok('headless events stream with aborted turn_ended → error finish (retryable)', () => {
  assert.equal(scanGrokTurnEnd([EV.turnEndedError]), 'error');
});

ok('no turn_ended yet → null (turn still running, no premature finish)', () => {
  assert.equal(scanGrokTurnEnd([EV.toolStartedRead, EV.phaseTool]), null);
});

console.log(`grokLoopForward smoke: ${pass} checks passed`);
