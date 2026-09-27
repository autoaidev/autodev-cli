// A minimal FAKE ACP agent for driving AcpSession in unit tests — speaks the
// same line-delimited JSON-RPC 2.0 as grok/opencode, no model involved.
//
// Behaviour (FIFO, one prompt "running" at a time, so a mid-run steer is queued
// like the real agents):
//   - initialize            -> {protocolVersion:1, agentCapabilities:{loadSession:true}}
//   - session/new           -> {sessionId:'fake-1'}
//   - session/prompt {text}:
//       * emits an agent_message_chunk echoing the text + '\n'
//       * if text contains 'OPENTOOL' -> emits a tool_call with NO terminal
//         tool_call_update (so the session must FLUSH it as ended: Bug B)
//       * if text contains 'CLOSETOOL' -> emits a tool_call AND its completed
//         tool_call_update
//       * resolves the prompt with stopReason 'end_turn' after ~80ms
//       * a prompt received while one is running is QUEUED and run after (Bug A)
import process from 'node:process';
import { appendFileSync as fsAppend } from 'node:fs';

let buf = '';
const queue = [];
let running = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-1', update: u } }); }

// Optional method log (Layer B attach-without-load tests assert session/load is
// NOT sent when attaching). Set FAKE_ACP_LOG to a file path.
function logMethod(m) {
  const f = process.env.FAKE_ACP_LOG;
  if (!f) return;
  try { fsAppend(f, m + '\n'); } catch { /* ignore */ }
}

function handle(msg) {
  if (msg.method) logMethod(msg.method);
  if (msg.method === 'initialize') { reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } }); return; }
  if (msg.method === 'session/new') { reply(msg.id, { sessionId: 'fake-1' }); return; }
  if (msg.method === 'session/list') {
    // Leader-style: report the warm session so attach-without-load can verify it.
    reply(msg.id, { sessions: [{ sessionId: 'fake-1', cwd: msg.params?.cwd ?? '', updatedAt: new Date().toISOString() }] });
    return;
  }
  if (msg.method === 'session/load') {
    // Replay prior history as session/update notifications BEFORE resolving —
    // exactly what grok/opencode do. The client must SUPPRESS these (Layer A.1).
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-HISTORY-LINE\n' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-replay', title: 'edit', rawInput: {} });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-replay', status: 'completed', content: [{ type: 'text', text: 'x' }] });
    reply(msg.id, {});
    return;
  }
  if (msg.method === 'session/prompt') {
    const text = (msg.params?.prompt?.[0]?.text) ?? '';
    queue.push({ id: msg.id, text });
    pump();
    return;
  }
  if (msg.method === 'session/cancel') { return; } // notification, no reply
}

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  // SILENT: resolve end_turn with NO output at all — a genuinely empty turn.
  // The client's trailing-chunk grace must NOT falsely mark it non-empty.
  if (job.text.includes('SILENT')) {
    setTimeout(() => { reply(job.id, { stopReason: 'end_turn' }); running = false; pump(); }, 40);
    return;
  }
  // TRAILING: the gpt-oss:20b race — resolve end_turn with no output yet, then
  // emit the FINAL agent_message_chunk a beat AFTER end_turn. The client's
  // bounded trailing-chunk grace must still count it (emptyOutput === false).
  if (job.text.includes('TRAILING')) {
    setTimeout(() => {
      reply(job.id, { stopReason: 'end_turn' });
      running = false;
      setTimeout(() => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TRAILING-FINAL\n' } });
        pump();
      }, 150);
    }, 40);
    return;
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: job.text + '\n' } });
  if (job.text.includes('HANG')) {
    // Never resolve this prompt — the client's per-turn watchdog must fire.
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-hang', title: 'sleep', rawInput: {} });
    return; // stays "running" forever
  }
  if (job.text.includes('OPENTOOL')) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-open', title: 'edit', rawInput: { a: 1 } });
    // NOTE: intentionally NO terminal tool_call_update -> must be flushed.
  }
  if (job.text.includes('CLOSETOOL')) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-closed', title: 'bash', rawInput: { cmd: 'ls' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-closed', status: 'completed', content: [{ type: 'text', text: 'done' }] });
  }
  setTimeout(() => {
    reply(job.id, { stopReason: 'end_turn' });
    running = false;
    pump();
  }, 80);
}
