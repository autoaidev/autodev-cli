// Offline smoke — the grok events.jsonl parser/classifier (../core/grokEvents).
//
// Covers the THREE converging grok-operate bugs the events.jsonl tailer fixes:
//   1+2 EVENTS + STATUS: grok's OWN native tool calls + turn lifecycle drive the
//       office badge + Events feed. A grok operate session is NOT an `autodev
//       start` loop, so nothing writes grok's tools into .autodev/hooks-events.jsonl
//       and grok has no Claude transcript — the bridge saw NOTHING. The parser maps
//       each event to a working/idle status signal and tool_started/completed to a
//       Pre/PostToolUse hook the office already renders.
//   3   CLEAN TURN vs StopFailure: a clean grok turn (events.jsonl shows
//       {"turn_ended","outcome":"completed"}) must classify as a clean finish, never
//       a stop_failure — so grok 4.7's clean turn-end (which may omit the grok-4.5
//       "Worked for N.Ns." pane marker) is not misread as a ❗ hard-fail.
//
// Grounded on the real grok 4.5/4.7 session dump shape.
// Run: node test/grokEvents.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const {
  parseGrokEventLine, classifyGrokActivity, grokEventToHook,
  isOfficeMcpToolName, scanGrokTurnEnd, isCleanTurnOutcome, grokAssistantText,
  GROK_IDLE_PHASES,
} = await import('../out/core/grokEvents.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grokEvents: parser / activity / hook / clean-turn classification');

// Real event lines copied from a grok session events.jsonl dump.
const L = {
  turnStarted: '{"ts":"2026-08-05T10:32:26.521Z","type":"turn_started","session_id":"019f","turn_number":0,"model_id":"grok-4.5","yolo_mode":true}',
  loopStarted: '{"ts":"2026-08-05T10:32:26.622Z","type":"loop_started","loop_index":0}',
  phaseWaiting: '{"ts":"2026-08-05T10:32:26.623Z","type":"phase_changed","phase":"waiting_for_model"}',
  phaseStreamText: '{"ts":"2026-08-05T10:32:37.628Z","type":"phase_changed","phase":"streaming_text"}',
  phaseTool: '{"ts":"2026-07-25T11:14:02.000Z","type":"phase_changed","phase":"tool_execution"}',
  firstToken: '{"ts":"2026-07-25T11:14:01.687Z","type":"first_token"}',
  toolStarted: '{"ts":"2026-07-25T11:14:02.282Z","type":"tool_started","tool_name":"search_tool"}',
  toolStartedRead: '{"ts":"2026-07-25T11:14:02.282Z","type":"tool_started","tool_name":"read_file","tool_call_id":"call_1"}',
  toolCompletedOk: '{"ts":"2026-07-25T11:14:02.283Z","type":"tool_completed","tool_name":"read_file","duration_ms":0,"outcome":"success","tool_call_id":"call_1"}',
  toolCompletedErr: '{"ts":"2026-07-25T11:14:02.283Z","type":"tool_completed","tool_name":"edit","duration_ms":3,"outcome":"error"}',
  toolStartedMcp: '{"ts":"2026-07-25T11:14:02.282Z","type":"tool_started","tool_name":"mcp__pixel-office__get_tasks"}',
  toolStartedOffice: '{"ts":"2026-07-25T11:14:02.282Z","type":"tool_started","tool_name":"get_tasks"}',
  permReq: '{"ts":"2026-07-25T11:14:02.282Z","type":"permission_requested","tool_name":"search_tool"}',
  permRes: '{"ts":"2026-07-25T11:14:02.283Z","type":"permission_resolved","tool_name":"search_tool","decision":"allow","wait_ms":0}',
  turnEndedOk: '{"ts":"2026-08-05T10:32:37.674Z","type":"turn_ended","outcome":"completed"}',
  turnEndedErr: '{"ts":"2026-08-05T10:32:37.674Z","type":"turn_ended","outcome":"error"}',
};

// ---------------------------------------------------------------------------
// 1. parseGrokEventLine — valid JSONL, blank, and non-JSON.
// ---------------------------------------------------------------------------
ok('parseGrokEventLine: valid → object; blank/junk → null', () => {
  assert.strictEqual(parseGrokEventLine(L.turnStarted).type, 'turn_started');
  assert.strictEqual(parseGrokEventLine(''), null);
  assert.strictEqual(parseGrokEventLine('   '), null);
  assert.strictEqual(parseGrokEventLine('not json'), null);
  assert.strictEqual(parseGrokEventLine('{"no":"type"}'), null);
  assert.strictEqual(parseGrokEventLine('{"partial'), null);
});

// ---------------------------------------------------------------------------
// 2. classifyGrokActivity — working vs end vs ignore (FIX 1+2 STATUS).
// ---------------------------------------------------------------------------
ok('classifyGrokActivity: lifecycle/tool/phase events → working', () => {
  for (const line of [L.turnStarted, L.loopStarted, L.firstToken, L.toolStarted,
    L.toolCompletedOk, L.permReq, L.permRes, L.phaseWaiting, L.phaseStreamText, L.phaseTool]) {
    assert.strictEqual(classifyGrokActivity(parseGrokEventLine(line)), 'working', line);
  }
});
ok('classifyGrokActivity: turn_ended → end (flip to idle NOW)', () => {
  assert.strictEqual(classifyGrokActivity(parseGrokEventLine(L.turnEndedOk)), 'end');
  assert.strictEqual(classifyGrokActivity(parseGrokEventLine(L.turnEndedErr)), 'end');
});
ok('classifyGrokActivity: an idle-style phase → end; unknown/null → null', () => {
  for (const p of GROK_IDLE_PHASES) {
    const ev = { type: 'phase_changed', phase: p };
    assert.strictEqual(classifyGrokActivity(ev), 'end', p);
  }
  assert.strictEqual(classifyGrokActivity(null), null);
  assert.strictEqual(classifyGrokActivity({ type: 'schema_migrated' }), null);
});

// ---------------------------------------------------------------------------
// 3. grokEventToHook — tool_started→PreToolUse, tool_completed→Post(/Failure).
// ---------------------------------------------------------------------------
ok('grokEventToHook: tool_started → PreToolUse (carries tool_name + id)', () => {
  const h = grokEventToHook(parseGrokEventLine(L.toolStartedRead));
  assert.strictEqual(h.hook_event_name, 'PreToolUse');
  assert.strictEqual(h.tool_name, 'read_file');
  assert.strictEqual(h.tool_use_id, 'call_1');
});
ok('grokEventToHook: tool_completed ok → PostToolUse; error → PostToolUseFailure', () => {
  const okh = grokEventToHook(parseGrokEventLine(L.toolCompletedOk));
  assert.strictEqual(okh.hook_event_name, 'PostToolUse');
  assert.strictEqual(okh.tool_name, 'read_file');
  assert.strictEqual(okh.tool_use_id, 'call_1');
  const errh = grokEventToHook(parseGrokEventLine(L.toolCompletedErr));
  assert.strictEqual(errh.hook_event_name, 'PostToolUseFailure');
  assert.strictEqual(errh.tool_name, 'edit');
});
ok('grokEventToHook: non-tool events → null (status-only)', () => {
  for (const line of [L.turnStarted, L.phaseStreamText, L.firstToken, L.turnEndedOk]) {
    assert.strictEqual(grokEventToHook(parseGrokEventLine(line)), null, line);
  }
});

// ---------------------------------------------------------------------------
// 4. isOfficeMcpToolName — don't double-forward office/MCP tools; keep native.
// ---------------------------------------------------------------------------
ok('isOfficeMcpToolName: mcp__* and office verbs skipped; grok native kept', () => {
  assert.strictEqual(isOfficeMcpToolName('mcp__pixel-office__get_tasks'), true);
  assert.strictEqual(isOfficeMcpToolName('get_tasks'), true);
  assert.strictEqual(isOfficeMcpToolName('send_message'), true);
  assert.strictEqual(isOfficeMcpToolName('graph_add_node'), true);
  // grok NATIVE tools — the high-value signal — are NOT skipped.
  assert.strictEqual(isOfficeMcpToolName('read_file'), false);
  assert.strictEqual(isOfficeMcpToolName('edit'), false);
  assert.strictEqual(isOfficeMcpToolName('bash'), false);
  assert.strictEqual(isOfficeMcpToolName('search_tool'), false);
  assert.strictEqual(isOfficeMcpToolName(''), false);
  assert.strictEqual(isOfficeMcpToolName(null), false);
});

// End-to-end mapping guard: an office tool event maps to a hook, but the tailer
// must SKIP it (server logs it), while grok's native read_file is forwarded.
ok('forward-decision: office/mcp tool skipped, grok native forwarded', () => {
  const office = grokEventToHook(parseGrokEventLine(L.toolStartedOffice));
  assert.ok(office && isOfficeMcpToolName(office.tool_name), 'office tool → skip');
  const mcp = grokEventToHook(parseGrokEventLine(L.toolStartedMcp));
  assert.ok(mcp && isOfficeMcpToolName(mcp.tool_name), 'mcp__ tool → skip');
  const native = grokEventToHook(parseGrokEventLine(L.toolStartedRead));
  assert.ok(native && !isOfficeMcpToolName(native.tool_name), 'grok native → forward');
});

// ---------------------------------------------------------------------------
// 5. FIX 3 — a CLEAN grok turn (events.jsonl turn_ended completed) is NOT a
//    stop_failure. An error/absent outcome is not falsely 'clean'.
// ---------------------------------------------------------------------------
ok('isCleanTurnOutcome: completed/success → true; error/blank → false', () => {
  assert.strictEqual(isCleanTurnOutcome('completed'), true);
  assert.strictEqual(isCleanTurnOutcome('success'), true);
  assert.strictEqual(isCleanTurnOutcome('error'), false);
  assert.strictEqual(isCleanTurnOutcome('cancelled'), false);
  assert.strictEqual(isCleanTurnOutcome(''), false);
  assert.strictEqual(isCleanTurnOutcome(undefined), false);
});
ok('scanGrokTurnEnd: a completed turn → "clean" (NOT a stop_failure)', () => {
  // A full clean turn: started → worked → ended completed.
  const lines = [L.turnStarted, L.loopStarted, L.firstToken, L.phaseStreamText, L.toolStarted, L.toolCompletedOk, L.turnEndedOk];
  assert.strictEqual(scanGrokTurnEnd(lines), 'clean');
  // The whole point of FIX 3: this must NOT be treated as a failure.
  assert.notStrictEqual(scanGrokTurnEnd(lines), 'error');
});
ok('scanGrokTurnEnd: an error turn_ended → "error"', () => {
  assert.strictEqual(scanGrokTurnEnd([L.turnStarted, L.turnEndedErr]), 'error');
  // An unknown non-clean outcome is a failure signal, not a false clean.
  assert.strictEqual(scanGrokTurnEnd(['{"type":"turn_ended","outcome":"weird"}']), 'error');
});
ok('scanGrokTurnEnd: no turn_ended (turn still running) → null', () => {
  assert.strictEqual(scanGrokTurnEnd([L.turnStarted, L.firstToken, L.phaseStreamText]), null);
  assert.strictEqual(scanGrokTurnEnd([]), null);
});
ok('scanGrokTurnEnd: LAST turn_ended wins (resumed session, prior + current turn)', () => {
  // A resumed session's log may hold a prior clean turn then the current one.
  assert.strictEqual(scanGrokTurnEnd([L.turnEndedOk, L.turnStarted, L.turnEndedErr]), 'error');
  assert.strictEqual(scanGrokTurnEnd([L.turnEndedErr, L.turnStarted, L.turnEndedOk]), 'clean');
});
ok('scanGrokTurnEnd: accepts parsed objects too (pure, no I/O)', () => {
  assert.strictEqual(scanGrokTurnEnd([{ type: 'turn_ended', outcome: 'completed' }]), 'clean');
});

// ---------------------------------------------------------------------------
// 6. grokAssistantText — narration extraction (FIX 1+2 EVENTS/chat bubbles).
// ---------------------------------------------------------------------------
ok('grokAssistantText: assistant string + block-array content; others → null', () => {
  assert.strictEqual(grokAssistantText('{"type":"assistant","content":"Let me update the backlog."}'), 'Let me update the backlog.');
  assert.strictEqual(grokAssistantText('{"role":"assistant","content":[{"type":"text","text":"Hi"},{"type":"text","text":"there"}]}'), 'Hi\nthere');
  assert.strictEqual(grokAssistantText('{"type":"user","content":"do it"}'), null);
  assert.strictEqual(grokAssistantText('{"type":"reasoning","content":"secret CoT"}'), null);
  assert.strictEqual(grokAssistantText('{"type":"tool_result","content":"out"}'), null);
  assert.strictEqual(grokAssistantText('{"type":"assistant","content":""}'), null);
  assert.strictEqual(grokAssistantText('not json'), null);
});

console.log(`\ngrokEvents smoke: ${pass} checks passed`);
