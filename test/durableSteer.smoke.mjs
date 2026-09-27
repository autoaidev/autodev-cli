// Unit smoke for the DURABLE-ACROSS-RESTART steer queue (1.4.192).
//
// Proves the mechanism the user needed: a mid-run steer that was delivered live
// but LOST when the session restarted before it ran now SURVIVES a restart with
// at-least-once delivery.
//
//   1. pendingSteers module: append-only queue, dedup by id, torn-line tolerant,
//      remove-on-completion.
//   2. AcpSession.steerTracked: returns a promise resolving when the steered turn
//      COMPLETES (so the caller acks/de-queues only then).
//   3. RESTART SURVIVAL: enqueue a steer, "kill" the session mid-steer, restart,
//      DRAIN the queue → the steer is (re)delivered and completes; the queue is
//      then empty so a completed steer is NOT re-run.
//
// Run: node test/durableSteer.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');
const { enqueuePendingSteer, readPendingSteers, removePendingSteer, hasPendingSteer, PENDING_STEERS_FILE } =
  await import('../out/pendingSteers.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(10); } return false; }

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-steer-'));
  return d;
}

console.log('durableSteer: at-least-once steer queue');

// --- 1. pendingSteers module ----------------------------------------------
ok('queue: enqueue appends; read returns it', () => {
  const root = tmpRoot();
  assert.equal(enqueuePendingSteer(root, { id: 'a', text: 'make me an html file', ts: 1 }), true);
  const list = readPendingSteers(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a');
  assert.equal(list[0].text, 'make me an html file');
  assert.ok(fs.existsSync(path.join(root, PENDING_STEERS_FILE)));
});

ok('queue: dedup by id (a reconnect-replay of the same steer is a no-op)', () => {
  const root = tmpRoot();
  assert.equal(enqueuePendingSteer(root, { id: 'x', text: 'first', ts: 1 }), true);
  assert.equal(enqueuePendingSteer(root, { id: 'x', text: 'first-again', ts: 2 }), false, 'dup id rejected');
  assert.equal(hasPendingSteer(root, 'x'), true);
  const list = readPendingSteers(root);
  assert.equal(list.length, 1, 'only one entry for the id');
});

ok('queue: remove de-queues by id; others preserved + order kept', () => {
  const root = tmpRoot();
  enqueuePendingSteer(root, { id: '1', text: 'one', ts: 1 });
  enqueuePendingSteer(root, { id: '2', text: 'two', ts: 2 });
  enqueuePendingSteer(root, { id: '3', text: 'three', ts: 3 });
  removePendingSteer(root, '2');
  const list = readPendingSteers(root);
  assert.deepEqual(list.map(s => s.id), ['1', '3']);
  removePendingSteer(root, '1');
  removePendingSteer(root, '3');
  assert.equal(readPendingSteers(root).length, 0, 'empty queue reads as []');
});

ok('queue: a torn / partial line (kill mid-append) is skipped, not fatal', () => {
  const root = tmpRoot();
  enqueuePendingSteer(root, { id: 'good', text: 'ok', ts: 1 });
  // Simulate a process killed mid-write: a trailing partial JSON line.
  fs.appendFileSync(path.join(root, PENDING_STEERS_FILE), '{"id":"torn","text":"hal', 'utf8');
  const list = readPendingSteers(root);
  assert.equal(list.length, 1, 'only the intact record survives');
  assert.equal(list[0].id, 'good');
});

// helper: AcpSession wired to the fake agent (mirrors acpSession.smoke.mjs).
function makeSession(root, initialSessionId) {
  const events = [];
  const spec = { buildArgs: () => [FAKE], narrationTitle: 'test', decodeUpdate: decodeAcpUpdateStandard };
  const sess = new AcpSession({
    root, bin: process.execPath, spec, initialSessionId,
    hooks: { emitHook: (name, extra) => events.push({ name, extra }), log: () => {} },
  });
  return { sess, events };
}

// --- 2. steerTracked resolves on COMPLETION -------------------------------
await okAsync('steerTracked: resolves only when the steered turn completes', async () => {
  const root = tmpRoot();
  const { sess } = makeSession(root);
  await sess.ensureReady();
  // Start a primary turn so the steer is a QUEUED continuation (Bug A path).
  const turn = sess.runTurn('primary work', () => {});
  assert.ok(await waitFor(() => sess.isBusy()), 'busy on primary');
  const p = sess.steerTracked('STEERED durable');
  assert.ok(p && typeof p.then === 'function', 'returns a completion promise');
  let done = false; void p.then(() => { done = true; });
  assert.equal(done, false, 'not resolved before the steered turn runs');
  const res = await p;
  assert.equal(res.clean, true, 'steered turn completed clean');
  await turn;
  sess.close();
});

ok('steerTracked: null when no live session (caller keeps it queued)', () => {
  const root = tmpRoot();
  const { sess } = makeSession(root);
  assert.equal(sess.steerTracked('x'), null, 'dead session → null');
});

// --- 3. RESTART SURVIVAL ---------------------------------------------------
// Replicates the loop's drain: for each queued steer, deliver to the live session,
// await completion, then de-queue. Proves the steer survives a restart and a
// completed steer is not re-run.
async function drainOnce(root, sess, seen) {
  for (const s of readPendingSteers(root)) {
    if (seen.has(s.id)) { continue; }
    seen.add(s.id);
    const p = sess.steerTracked(s.text);
    if (!p) { seen.delete(s.id); continue; }
    await p;                       // steered turn completed
    removePendingSteer(root, s.id); // de-queue ONLY on completion
  }
}

await okAsync('RESTART: kill mid-steer → restart drains + completes the steer once', async () => {
  const root = tmpRoot();
  // A steer arrived and was persisted; the loop was then KILLED before it ran.
  enqueuePendingSteer(root, { id: 'steer-42', text: 'make me an html file', ts: Date.now() });
  assert.equal(readPendingSteers(root).length, 1, 'steer durably queued pre-restart');

  // "Restart": a brand-new session for the same root (fresh process).
  const { sess, events } = makeSession(root, 'fake-1'); // session/load restore path
  await sess.ensureReady();
  const seen = new Set();
  await drainOnce(root, sess, seen);

  // The steer was delivered + completed and de-queued exactly once.
  assert.equal(readPendingSteers(root).length, 0, 'queue drained after completion');
  const narrated = events.filter(e => e.name === 'Notification').map(e => String(e.extra.message));
  assert.ok(narrated.some(m => m.includes('make me an html file')), 'the steer actually RAN after restart');

  // A second drain (e.g. a server reconnect-replay + boundary tick) must NOT re-run
  // the completed steer — the queue is empty and the id is already seen.
  const before = events.filter(e => e.name === 'Notification').length;
  await drainOnce(root, sess, seen);
  const after = events.filter(e => e.name === 'Notification').length;
  assert.equal(after, before, 'completed steer is NOT re-run');
  sess.close();
});

await okAsync('RESTART: an INTERRUPTED steer (never completed) stays queued for redelivery', async () => {
  const root = tmpRoot();
  enqueuePendingSteer(root, { id: 'steer-hang', text: 'HANG please', ts: Date.now() });
  // First "run": deliver but the process dies before completion (fake HANGs, then
  // we close the session → the promise rejects/never-resolves). We do NOT de-queue.
  const first = makeSession(root, 'fake-1');
  await first.sess.ensureReady();
  const p = first.sess.steerTracked('HANG please');
  assert.ok(p, 'delivered to the live session');
  await sleep(50);
  first.sess.close(); // kill mid-steer — completion never observed → NOT de-queued
  assert.equal(readPendingSteers(root).length, 1, 'interrupted steer stays queued');

  // Because it stayed queued, the RESTART redelivers it. Swap the text so it can
  // actually complete this time and prove redelivery happens.
  removePendingSteer(root, 'steer-hang');
  enqueuePendingSteer(root, { id: 'steer-hang', text: 'now it completes', ts: Date.now() });
  const second = makeSession(root, 'fake-1');
  await second.sess.ensureReady();
  await drainOnce(root, second.sess, new Set());
  assert.equal(readPendingSteers(root).length, 0, 'redelivered + completed after restart');
  second.sess.close();
});

console.log(`durableSteer: ${pass} checks passed`);
