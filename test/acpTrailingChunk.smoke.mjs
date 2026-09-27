// Offline smoke — ACP trailing-chunk grace (1.4.194 FIX 3B).
//
// gpt-oss:20b (and some slow local models over ACP) can emit their FINAL
// agent_message_chunk a beat AFTER end_turn resolves. Without a grace the loop
// reads _turnHadOutput===false and declares a SPURIOUSLY-empty turn. runTurn now
// waits a small bounded window (default 600ms, env AUTODEV_ACP_TRAILING_CHUNK_MS)
// for a trailing chunk before computing emptyOutput — done BEFORE nulling the sink
// so the late chunk still reaches the sink/narration. It is skipped entirely when
// the turn already produced output, so a normal turn adds no latency, and a
// genuinely silent turn still reports emptyOutput=true.
// Run: node test/acpTrailingChunk.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');

let pass = 0;
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };

console.log('acpSession: trailing-chunk grace prevents spurious empty turns');

function makeSession() {
  const events = [];
  const spec = { buildArgs: () => [FAKE], narrationTitle: 'test', decodeUpdate: decodeAcpUpdateStandard };
  const sess = new AcpSession({
    root: process.cwd(), bin: process.execPath, spec,
    hooks: { emitHook: (name, extra) => events.push({ name, extra }), log: () => {} },
  });
  return { sess, events };
}

// config helper: default + env override + disable.
await okAsync('config: trailingChunkGraceMs default 600, env override, 0 disables', async () => {
  assert.strictEqual(AcpSession.trailingChunkGraceMs(), 600, 'default 600ms');
  process.env.AUTODEV_ACP_TRAILING_CHUNK_MS = '250';
  assert.strictEqual(AcpSession.trailingChunkGraceMs(), 250, 'env override honoured');
  process.env.AUTODEV_ACP_TRAILING_CHUNK_MS = '0';
  assert.strictEqual(AcpSession.trailingChunkGraceMs(), 0, '0 disables the grace');
  delete process.env.AUTODEV_ACP_TRAILING_CHUNK_MS;
});

// The core fix: a chunk that lands AFTER end_turn is still counted (not empty),
// and its text reaches the sink because the grace runs before the sink is nulled.
await okAsync('trailing chunk after end_turn → NOT a spurious empty turn (grace on)', async () => {
  const { sess } = makeSession();
  const sink = [];
  const res = await sess.runTurn('please answer TRAILING', (t) => sink.push(t));
  assert.strictEqual(res.clean, true, 'end_turn is clean');
  assert.strictEqual(res.emptyOutput, false, 'the trailing final chunk is counted — turn is NOT flagged empty');
  assert.ok(sink.join('').includes('TRAILING-FINAL'), 'the late chunk still reached the sink (grace ran before sink null)');
  sess.close();
});

// With the grace DISABLED, the same late chunk is missed at decision time → the
// turn is (spuriously) flagged empty. Proves the grace is what fixes it.
await okAsync('grace disabled → the same late chunk is missed (turn flagged empty)', async () => {
  process.env.AUTODEV_ACP_TRAILING_CHUNK_MS = '0';
  const { sess } = makeSession();
  const res = await sess.runTurn('please answer TRAILING', () => {});
  assert.strictEqual(res.clean, true, 'still a clean end_turn');
  assert.strictEqual(res.emptyOutput, true, 'without the grace the late chunk is missed → spuriously empty (the bug)');
  delete process.env.AUTODEV_ACP_TRAILING_CHUNK_MS;
  sess.close();
});

// A genuinely silent turn (no chunk EVER) must still report empty even with the
// grace on — the grace must not manufacture output where there is none.
await okAsync('genuinely silent turn still reports emptyOutput=true (grace does not fabricate)', async () => {
  const { sess } = makeSession();
  const res = await sess.runTurn('stay SILENT please', () => {});
  assert.strictEqual(res.clean, true, 'a silent turn is still clean');
  assert.strictEqual(res.emptyOutput, true, 'no chunk ever → correctly empty even after the grace window');
  sess.close();
});

// A normal turn (chunk arrives immediately) is unaffected — no added latency, not empty.
await okAsync('normal turn: immediate chunk → not empty, grace skipped', async () => {
  const { sess } = makeSession();
  const t0 = Date.now();
  const res = await sess.runTurn('hello there', () => {});
  assert.strictEqual(res.emptyOutput, false, 'normal turn produced output');
  assert.ok(Date.now() - t0 < 600, 'grace was skipped (no 600ms tax on a turn that already produced output)');
  sess.close();
});

console.log(`\n${pass} assertions passed ✓`);
