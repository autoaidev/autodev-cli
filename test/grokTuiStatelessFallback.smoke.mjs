// Offline smoke — grok-tui headless routing: tmux vs headless, and the headless
// resume/bootstrap/stateless decision.
//
// HISTORY: 1.4.178 made headless grok-tui UNCONDITIONALLY stateless because grok
// 1.0.41's headless `grok --resume` could hang the resumed turn (loaded-but-never-
// answers → 10-min watchdog → false StopFailure → retry forever) on boxes with no
// tmux (e.g. Windows). That fixed the hang but LOST cross-turn context ("session=new"
// every turn). 1.4.180 restored persistence behind a first_token hang-probe, but a
// SINGLE transient hang set a PERMANENT per-run "resumeBroken" flag → every later turn
// went stateless (fresh unknown id) → no continuity for the whole run (the live 1.4.182
// Windows/grok-cli symptom: "no tmux and --resume marked non-resumable this run —
// running stateless" every turn). 1.4.184 replaces that permanent poison with a BOUNDED
// consecutive-failure counter: resume is re-attempted every turn, resets to 0 the moment
// a resume answers, and only takes ONE stateless breather after N straight failures —
// so persistence self-heals and the stored id is never abandoned.
//
// This asserts the pure decision helpers (no process spawn):
//   decideGrokRunMode      — grok-tui+tmux → tmux path; else → headless path.
//   decideHeadlessGrokMode — headless launch choice: continue / new-session / stateless,
//                            driven by (hasFolderSession, consecutiveResumeFailures).
//                            [1.4.187: `grok --continue` replaces `--resume <id>`, which
//                            errored in ~1s on Windows; the choice keys off folder-session
//                            presence, not a stale stored id.]
//   grokSessionArgsFor     — CLI flags; `--continue` is NEVER combined with `--session-id`.
//
// Run: node test/grokTuiStatelessFallback.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { decideGrokRunMode, decideHeadlessGrokMode, grokSessionArgsFor } = await import('../out/providers/grok/tui.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grok-tui: headless routing (tmux vs headless; resume/bootstrap/stateless)');

// --- decideGrokRunMode: only grok-tui WITH tmux takes the persistent tmux path ---
ok('grok-tui + tmux → tmux persistent path (useTmux:true)', () => {
  assert.strictEqual(decideGrokRunMode({ tmuxAvailable: true, providerId: 'grok-tui' }).useTmux, true);
});
ok('grok-tui + NO tmux → headless path (useTmux:false)', () => {
  assert.strictEqual(decideGrokRunMode({ tmuxAvailable: false, providerId: 'grok-tui' }).useTmux, false);
});
ok('grok-cli → never uses tmux (useTmux:false either way)', () => {
  assert.strictEqual(decideGrokRunMode({ tmuxAvailable: false, providerId: 'grok-cli' }).useTmux, false);
  assert.strictEqual(decideGrokRunMode({ tmuxAvailable: true, providerId: 'grok-cli' }).useTmux, false);
});

// --- decideHeadlessGrokMode: the headless launch choice (bounded, self-healing) -----
// 1.4.187: the decision keys off FOLDER-SESSION PRESENCE (does grok have a session on
// disk for this cwd?), NOT a stored id — because the fix resumes via `grok --continue`
// (no id), and keying off a stale/mismatched stored id is exactly what drove the doomed
// `--resume <id>` that errored in ~1s on Windows. Modes: continue / new-session / stateless.
ok('headless + a folder session exists, no failures → CONTINUE (steady state, every turn)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 0 }), 'continue');
});
ok('headless + NO folder session → NEW-SESSION (bootstrap a fresh named session)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: false, consecutiveResumeFailures: 0 }), 'new-session');
  // Nothing on disk to continue even after failures → still bootstrap (never "stateless forever").
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: false, consecutiveResumeFailures: 9 }), 'new-session');
});

// THE REGRESSION GUARD: a single (or a few) transient failure must NOT poison the run —
// continue is re-attempted next turn. This is the exact bug the live symptom hit.
ok('headless + folder session + 1 or 2 failures → STILL CONTINUE (no permanent poison)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 1 }), 'continue');
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 2 }), 'continue');
});
ok('headless + folder session + >= max consecutive failures → ONE stateless breather turn', () => {
  // Sustained failures take a single breather (skip the probe cost); the caller then
  // resets the counter so the FOLLOWING turn returns to continue. Never permanent.
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 3 }), 'stateless');
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 99 }), 'stateless');
  // Threshold is tunable via the arg (defaults to RESUME_MAX_CONSEC_FAILURES=3).
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 4, maxConsecutiveFailures: 5 }), 'continue');
  assert.strictEqual(decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: 5, maxConsecutiveFailures: 5 }), 'stateless');
});

// --- grokSessionArgsFor: the CLI-flag invariants (1.4.187) --------------------------
// The core regression the user hit was `--resume <staleId>` erroring instantly. The fix
// switches the headless path to `grok --continue`. grok REJECTS `--session-id` together
// with `--continue`/`--resume` unless `--fork-session` (which we never want), so the
// builder must NEVER combine them.
ok('grokSessionArgsFor: continue → EXACTLY ["--continue"], never an id or --session-id', () => {
  assert.deepStrictEqual(grokSessionArgsFor({ continueSession: true }), ['--continue']);
  // continue wins even if an id/new id is also (mistakenly) supplied — never combined.
  const withId = grokSessionArgsFor({ continueSession: true, sessionId: 'abc', newSessionId: 'def' });
  assert.deepStrictEqual(withId, ['--continue']);
  assert.ok(!withId.includes('--session-id'), '--session-id must NEVER accompany --continue');
  assert.ok(!withId.includes('--resume'), '--resume must NEVER accompany --continue');
});
ok('grokSessionArgsFor: explicit id → ["--resume", id]; fresh id → ["--session-id", id]; none → []', () => {
  assert.deepStrictEqual(grokSessionArgsFor({ sessionId: 'sid-1' }), ['--resume', 'sid-1']);
  assert.deepStrictEqual(grokSessionArgsFor({ newSessionId: 'uuid-1' }), ['--session-id', 'uuid-1']);
  assert.deepStrictEqual(grokSessionArgsFor({}), []);
  // --continue and --session-id are mutually exclusive in every combination.
  for (const a of [grokSessionArgsFor({ sessionId: 'x' }), grokSessionArgsFor({ newSessionId: 'y' })]) {
    assert.ok(!a.includes('--continue'), 'a resume/new launch must not carry --continue');
  }
});

// --- SEQUENCE INVARIANT: a run can never get permanently stuck in stateless ---
// Mirror sendGrokPersistentHeadless's caller loop: attempt = decideHeadlessGrokMode;
// a resume FAILURE increments the counter; a resume SUCCESS (first_token) resets it to
// 0; a 'stateless' breather also resets it to 0 (then retries resume). Drive it through
// an adversarial "resume always fails" run and assert resume keeps being re-attempted
// (never the old permanent-stateless death spiral) AND that once resume starts working,
// every subsequent turn resumes.
ok('sequence: continue is re-attempted forever (bounded breathers), and self-heals', () => {
  const MAX = 3;
  let failures = 0;
  const step = (resumeOutcome) => {
    // resumeOutcome: 'fail' | 'ok' | null (null when this turn wasn't a continue)
    const decision = decideHeadlessGrokMode({ hasFolderSession: true, consecutiveResumeFailures: failures, maxConsecutiveFailures: MAX });
    if (decision === 'stateless') { failures = 0; return decision; }      // breather resets
    if (decision === 'continue') {
      if (resumeOutcome === 'ok') { failures = 0; }
      else if (resumeOutcome === 'fail') { failures += 1; }
    }
    return decision;
  };

  // 12 turns where continue ALWAYS fails: must be a repeating continue,continue,continue,
  // stateless cycle — continue is attempted the large majority of turns, breather at most
  // 1-in-(MAX+1).
  const seq = [];
  for (let i = 0; i < 12; i++) { seq.push(step('fail')); }
  const contCount = seq.filter(d => d === 'continue').length;
  const statelessCount = seq.filter(d => d === 'stateless').length;
  assert.ok(contCount >= 9, `continue must dominate even under constant failure (got ${contCount}/12): ${seq.join(',')}`);
  assert.ok(statelessCount <= 3, `stateless breathers must be rare (got ${statelessCount}/12): ${seq.join(',')}`);
  // Never two stateless in a row (a breather always resets → next turn continues).
  for (let i = 1; i < seq.length; i++) {
    assert.ok(!(seq[i] === 'stateless' && seq[i - 1] === 'stateless'), 'two stateless turns in a row = the permanent-poison bug');
  }

  // Now continue starts SUCCEEDING → from then on every turn continues (full continuity).
  failures = 2; // carry a couple of prior hiccups in
  assert.strictEqual(step('ok'), 'continue');   // attempts continue despite prior failures
  assert.strictEqual(failures, 0);              // success cleared the counter
  assert.strictEqual(step('ok'), 'continue');   // and stays continuing
  assert.strictEqual(step('ok'), 'continue');
});

console.log(`\ngrok-tui headless routing: ${pass} checks passed`);
