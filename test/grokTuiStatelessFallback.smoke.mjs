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
//   decideHeadlessGrokMode — headless launch choice: resume / new-persistent / stateless,
//                            driven by (hasSessionId, consecutiveResumeFailures).
//
// Run: node test/grokTuiStatelessFallback.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { decideGrokRunMode, decideHeadlessGrokMode } = await import('../out/providers/grok/tui.js');

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

// --- decideHeadlessGrokMode: the headless launch choice (bounded, self-healing) ---
ok('headless + stored session id, no failures → RESUME (the steady state, every turn)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 0 }), 'resume');
});
ok('headless + no session id → NEW-PERSISTENT (bootstrap a fresh named session)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: false, consecutiveResumeFailures: 0 }), 'new-persistent');
  // No id to reuse even after failures → still bootstrap (never a "stateless forever").
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: false, consecutiveResumeFailures: 9 }), 'new-persistent');
});

// THE REGRESSION GUARD: a single (or a few) transient resume failure must NOT poison
// the run — resume is re-attempted next turn. This is the exact bug the live symptom hit.
ok('headless + stored id + 1 or 2 resume failures → STILL RESUME (no permanent poison)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 1 }), 'resume');
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 2 }), 'resume');
});
ok('headless + stored id + >= max consecutive failures → ONE stateless breather turn', () => {
  // Sustained failures take a single breather (skip the probe cost); the caller then
  // resets the counter so the FOLLOWING turn returns to resume. Never permanent.
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 3 }), 'stateless');
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 99 }), 'stateless');
  // Threshold is tunable via the arg (defaults to RESUME_MAX_CONSEC_FAILURES=3).
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 4, maxConsecutiveFailures: 5 }), 'resume');
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: 5, maxConsecutiveFailures: 5 }), 'stateless');
});

// --- SEQUENCE INVARIANT: a run can never get permanently stuck in stateless ---
// Mirror sendGrokPersistentHeadless's caller loop: attempt = decideHeadlessGrokMode;
// a resume FAILURE increments the counter; a resume SUCCESS (first_token) resets it to
// 0; a 'stateless' breather also resets it to 0 (then retries resume). Drive it through
// an adversarial "resume always fails" run and assert resume keeps being re-attempted
// (never the old permanent-stateless death spiral) AND that once resume starts working,
// every subsequent turn resumes.
ok('sequence: resume is re-attempted forever (bounded breathers), and self-heals', () => {
  const MAX = 3;
  let failures = 0;
  const step = (resumeOutcome) => {
    // resumeOutcome: 'fail' | 'ok' | null (null when this turn wasn't a resume)
    const decision = decideHeadlessGrokMode({ hasSessionId: true, consecutiveResumeFailures: failures, maxConsecutiveFailures: MAX });
    if (decision === 'stateless') { failures = 0; return decision; }      // breather resets
    if (decision === 'resume') {
      if (resumeOutcome === 'ok') { failures = 0; }
      else if (resumeOutcome === 'fail') { failures += 1; }
    }
    return decision;
  };

  // 10 turns where resume ALWAYS fails: must be a repeating resume,resume,resume,stateless
  // cycle — resume is attempted the large majority of turns, breather at most 1-in-(MAX+1).
  const seq = [];
  for (let i = 0; i < 12; i++) { seq.push(step('fail')); }
  const resumeCount = seq.filter(d => d === 'resume').length;
  const statelessCount = seq.filter(d => d === 'stateless').length;
  assert.ok(resumeCount >= 9, `resume must dominate even under constant failure (got ${resumeCount}/12): ${seq.join(',')}`);
  assert.ok(statelessCount <= 3, `stateless breathers must be rare (got ${statelessCount}/12): ${seq.join(',')}`);
  // Never two stateless in a row (a breather always resets → next turn resumes).
  for (let i = 1; i < seq.length; i++) {
    assert.ok(!(seq[i] === 'stateless' && seq[i - 1] === 'stateless'), 'two stateless turns in a row = the permanent-poison bug');
  }

  // Now resume starts SUCCEEDING → from then on every turn resumes (full continuity).
  failures = 2; // carry a couple of prior hiccups in
  assert.strictEqual(step('ok'), 'resume');   // attempts resume despite prior failures
  assert.strictEqual(failures, 0);            // success cleared the counter
  assert.strictEqual(step('ok'), 'resume');   // and stays resuming
  assert.strictEqual(step('ok'), 'resume');
});

console.log(`\ngrok-tui headless routing: ${pass} checks passed`);
