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
// 1.4.202 GENERALIZATION: grok-cli/grok-tui route dispatch through the SAME persistent
// `sendGrokAcpPrompt` as grok-acp when grokAcpEnabled(), so they hit the SAME 30s
// exit-file stall at each turn boundary. The predicate now carves them out too — but
// only over the ACP session (grokAcpEnabled()); the legacy one-shot/tmux path is
// unchanged.
//
// This test asserts:
//   (1) the loop PREDICATE usesGrokAcpSession(): grok-acp is ALWAYS carved out;
//       grok-cli/grok-tui are carved out when grokAcpEnabled() (persistent ACP ON)
//       and stay on the exit-file path when it is disabled; all other providers
//       (claude/copilot/opencode *, undefined) are never carved out;
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

// Deterministic grokAcpEnabled() seam — set BEFORE importing taskLoop/grok so the
// module-load `GROK_BIN` const points at a fake `grok` whose `agent --help` output
// contains "stdio". grokAgentStdioSupported() then resolves TRUE (and caches it) with
// no real grok install, so the persistent-ACP branch is exercised offline. Env is
// read on every grokAcpEnabled() call, so we can still toggle the disabled branch via
// AUTODEV_GROK_PERSISTENT below without touching the cached probe.
process.env.GROK_BIN = path.join(__dirname, 'fixtures', 'fakeGrokStdioBin.sh');
delete process.env.AUTODEV_GROK_PERSISTENT; // default ON (supported ⇒ enabled)

const { usesGrokAcpSession } = await import('../out/taskLoop.js');
const { grokAcpEnabled } = await import('../out/providers/grokTuiProvider.js');
const { PROVIDERS } = await import('../out/providers.js');
const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(5); } return false; }

console.log('grokAcpTurnCompletion: persistent-ACP turn-completion carve-out');

// --- (1) predicate contract (1.4.202 generalization) -----------------------
// grok-acp is ALWAYS carved onto the busy-flag path; grok-cli/grok-tui are carved
// out too, but ONLY when they run over the persistent ACP session (grokAcpEnabled()).
// The 1-arg (no-root) form answers the label question: grokAcpEnabled() for
// grok-cli/grok-tui. The call sites pass a root to additionally require a LIVE ACP
// session (hasGrokAcpSession) so an ACP→headless fallback stays on the exit-file
// path; that is covered by the AcpSession busy-flag test (3) below.

// --- enabled branch: persistent ACP is ON (fake GROK_BIN exposes `agent stdio`) ---
ok('grokAcpEnabled() is TRUE with the fake stdio-capable grok (seam works)', () => {
  assert.equal(grokAcpEnabled(), true);
});
ok('grok-acp is ALWAYS carved out (persistent-ACP by definition)', () => {
  assert.equal(usesGrokAcpSession('grok-acp'), true);
});
ok('grok-cli / grok-tui ARE carved out when grokAcpEnabled()', () => {
  assert.equal(usesGrokAcpSession('grok-cli'), true, 'grok-cli over ACP → busy-flag path');
  assert.equal(usesGrokAcpSession('grok-tui'), true, 'grok-tui over ACP → busy-flag path');
});
ok('other / unknown providers are NEVER carved out (stay on the exit-file path)', () => {
  for (const p of ['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk',
                   'opencode-cli', 'opencode-sdk', 'dummy', undefined, '']) {
    assert.equal(usesGrokAcpSession(p), false, `${p} must not be treated as persistent-ACP`);
  }
});

// --- disabled branch: AUTODEV_GROK_PERSISTENT forces the legacy one-shot path ---
ok('grok-cli / grok-tui are NOT carved out when the persistent path is disabled', () => {
  const prev = process.env.AUTODEV_GROK_PERSISTENT;
  process.env.AUTODEV_GROK_PERSISTENT = 'off';
  try {
    assert.equal(grokAcpEnabled(), false, 'env override forces legacy headless/tmux');
    assert.equal(usesGrokAcpSession('grok-cli'), false, 'grok-cli legacy → exit-file path');
    assert.equal(usesGrokAcpSession('grok-tui'), false, 'grok-tui legacy → exit-file path');
    // grok-acp is ACP by definition — the env toggle must never move it off the carve-out.
    assert.equal(usesGrokAcpSession('grok-acp'), true, 'grok-acp stays carved out regardless');
  } finally {
    if (prev === undefined) { delete process.env.AUTODEV_GROK_PERSISTENT; }
    else { process.env.AUTODEV_GROK_PERSISTENT = prev; }
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
