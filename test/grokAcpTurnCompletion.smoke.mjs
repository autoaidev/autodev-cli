// Offline smoke — grok-acp turn-completion carve-out (1.4.201).
//
// Regression: grok-acp is a PERSISTENT ACP provider (one long-lived
// `grok agent stdio` process; kind 'sdk'), but it is also marked isCli:true.
// The taskLoop's post-dispatch wait used to treat every isCli provider as a
// per-turn-CLI spawn: it polled for a per-message `exit.txt` for 30s and, when
// that file never appeared (ACP writes no per-turn child exit file on its own
// schedule — the turn ends when AcpSession.runTurn() RESOLVES), logged the
// spurious "CLI exit file never written — wrote sentinel to unblock next cycle"
// warning and wrote an 'unknown' sentinel. This carved grok-acp onto the same
// busy-flag completion path the other persistent 'sdk' providers already use.
//
// This test asserts:
//   (1) the loop PREDICATE usesGrokAcpSession() selects ONLY grok-acp — the
//       per-turn-CLI providers (claude/grok/copilot/opencode *-cli, grok-tui)
//       are NOT carved out and stay on the exit-file path unchanged;
//   (2) grok-acp is isCli:true (so WITHOUT the carve-out it WOULD have fallen
//       into the exit-file+sentinel branch — documenting WHY the branch exists);
//   (3) the signal the loop now waits on — AcpSession.isBusy() — is true for the
//       whole turn and clears exactly when runTurn() RESOLVES (driven against the
//       offline fake ACP agent, no model), i.e. completion derives from the
//       runTurn result, not from a per-turn exit file.
//
// Run: node test/grokAcpTurnCompletion.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const { usesGrokAcpSession } = await import('../out/taskLoop.js');
const { PROVIDERS } = await import('../out/providers.js');
const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(5); } return false; }

console.log('grokAcpTurnCompletion: persistent-ACP turn-completion carve-out');

// --- (1) predicate selects ONLY grok-acp -----------------------------------
ok('usesGrokAcpSession is TRUE only for grok-acp', () => {
  assert.equal(usesGrokAcpSession('grok-acp'), true);
});
ok('per-turn-CLI providers are NOT carved out (stay on the exit-file path)', () => {
  for (const p of ['grok-cli', 'grok-tui', 'claude-cli', 'claude-tui',
                   'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk',
                   'dummy', undefined, '']) {
    assert.equal(usesGrokAcpSession(p), false, `${p} must not be treated as persistent-ACP`);
  }
});

// --- (2) grok-acp is isCli:true → the carve-out must run BEFORE the isCli branch
ok('grok-acp is isCli:true (so the carve-out must precede the exit-file branch)', () => {
  assert.equal(PROVIDERS['grok-acp'].isCli, true);
});

// --- (3) completion derives from runTurn() resolving (busy flag), not an exit file
function makeSession() {
  const spec = { buildArgs: () => [FAKE], narrationTitle: 'test', decodeUpdate: decodeAcpUpdateStandard };
  return new AcpSession({
    root: process.cwd(), bin: process.execPath, spec,
    hooks: { emitHook: () => {}, log: () => {} },
  });
}

await okAsync('isBusy() is false before, true during, false after runTurn() resolves', async () => {
  const sess = makeSession();
  await sess.ensureReady();
  assert.equal(sess.isBusy(), false, 'idle before the turn');
  const turn = sess.runTurn('hello', () => {});
  assert.ok(await waitFor(() => sess.isBusy()), 'busy while the turn is in flight (the loop waits on this)');
  const res = await turn;
  assert.equal(sess.isBusy(), false, 'busy clears exactly when runTurn resolves — the completion signal');
  assert.equal(res.clean, true, 'fake agent ends the turn with end_turn → clean (classified from stopReason, not an exit file)');
  assert.equal(res.stopReason, 'end_turn');
  sess.close();
});

console.log(`\ngrokAcpTurnCompletion: ${pass} checks passed`);
