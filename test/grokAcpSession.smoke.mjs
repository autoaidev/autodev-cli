// Offline smoke — the persistent-process (ACP) grok session decoders
// (../providers/grok/GrokAcpSession). Uses REAL frames captured from
// `grok agent stdio` (grok 1.0.13) during reverse-engineering.
//
// Run: node test/grokAcpSession.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { decodeAcpUpdate, extractToolOutput, classifyAcpResult } =
  await import('../out/providers/grok/GrokAcpSession.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grokAcpSession: ACP session/update + result decoders');

// --- agent_message_chunk (real frame) → assistant text ---
ok('agent_message_chunk → assistant text', () => {
  const frame = { jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PLATYPUS-42' } } } };
  const d = decodeAcpUpdate(frame);
  assert.equal(d.kind, 'assistant');
  assert.equal(d.text, 'PLATYPUS-42');
});

// --- tool_call (real frame) → PreToolUse mapping, prefers x.ai/tool.name ---
ok('tool_call → tool_call with real name + rawInput', () => {
  const frame = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
    sessionUpdate: 'tool_call', toolCallId: 'call-834-0', title: 'search_replace',
    rawInput: { file_path: '/tmp/note.txt', old_string: '', new_string: 'hello-world' },
    _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit', read_only: false } } } } };
  const d = decodeAcpUpdate(frame);
  assert.equal(d.kind, 'tool_call');
  assert.equal(d.id, 'call-834-0');
  assert.equal(d.name, 'search_replace');
  assert.equal(d.input.new_string, 'hello-world');
});

ok('tool_call falls back to title when no _meta name', () => {
  const d = decodeAcpUpdate({ method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', rawInput: { cmd: 'ls' } } } });
  assert.equal(d.name, 'bash');
});

// --- tool_call_update completed (real frame) → tool_result ---
ok('tool_call_update completed → tool_result', () => {
  const frame = { method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'call-834-0', status: 'completed',
    content: [{ type: 'diff', path: '/tmp/note.txt', oldText: '', newText: 'hello-world' }],
    rawOutput: { type: 'SearchReplace', ok: true } } } };
  const d = decodeAcpUpdate(frame);
  assert.equal(d.kind, 'tool_result');
  assert.equal(d.id, 'call-834-0');
  assert.equal(d.status, 'completed');
  assert.ok(d.outputText.includes('SearchReplace'));
});

ok('tool_call_update in-progress (no status) → other (not forwarded)', () => {
  const d = decodeAcpUpdate({ method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Edit `x`' } } });
  assert.equal(d.kind, 'other');
});

ok('bookkeeping notifications → other', () => {
  for (const su of ['available_commands_update', 'turn_completed', 'user_message_chunk', 'response_completed']) {
    assert.equal(decodeAcpUpdate({ method: 'session/update', params: { update: { sessionUpdate: su } } }).kind, 'other');
  }
  // non-session/update notifications ignored
  assert.equal(decodeAcpUpdate({ method: '_x.ai/queue/changed', params: {} }).kind, 'other');
  assert.equal(decodeAcpUpdate({ jsonrpc: '2.0', id: 1, result: {} }).kind, 'other');
  assert.equal(decodeAcpUpdate(null).kind, 'other');
});

// --- extractToolOutput variants ---
ok('extractToolOutput: rawOutput object / string / content diff', () => {
  assert.ok(extractToolOutput({ rawOutput: { a: 1 } }).includes('"a":1'));
  assert.equal(extractToolOutput({ rawOutput: 'done' }), 'done');
  assert.equal(extractToolOutput({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
  assert.equal(extractToolOutput({ content: [{ type: 'diff', newText: 'X' }] }), 'X');
  assert.equal(extractToolOutput({}), '');
});

// --- classifyAcpResult (real result frames) ---
ok('classifyAcpResult: end_turn → clean', () => {
  const r = classifyAcpResult({ result: { stopReason: 'end_turn', _meta: { totalTokens: 14949 } } });
  assert.equal(r.clean, true);
  assert.equal(r.stopReason, 'end_turn');
});

ok('classifyAcpResult: cancelled (mid-turn abort) → clean, not a failure', () => {
  const r = classifyAcpResult({ result: { stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } } });
  assert.equal(r.clean, true);
});

ok('classifyAcpResult: max_tokens → clean', () => {
  assert.equal(classifyAcpResult({ result: { stopReason: 'max_tokens' } }).clean, true);
});

ok('classifyAcpResult: jsonrpc error → error(exit 1)', () => {
  const r = classifyAcpResult({ error: { message: 'grok agent exited (code=1)' } });
  assert.equal(r.clean, false);
  assert.equal(r.stopReason, 'error');
  assert.ok(r.error.includes('exited'));
});

ok('classifyAcpResult: unknown stopReason → error', () => {
  assert.equal(classifyAcpResult({ result: { stopReason: 'refusal' } }).clean, false);
  assert.equal(classifyAcpResult({ result: {} }).clean, false);
});

console.log(`\ngrokAcpSession: ${pass} checks passed`);
