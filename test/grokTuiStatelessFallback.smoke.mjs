// Offline smoke — grok-tui headless routing: tmux vs headless, and the headless
// resume/bootstrap/stateless decision.
//
// HISTORY: 1.4.178 made headless grok-tui UNCONDITIONALLY stateless because grok
// 1.0.41's headless `grok --resume` could hang the resumed turn (loaded-but-never-
// answers → 10-min watchdog → false StopFailure → retry forever) on boxes with no
// tmux (e.g. Windows). That fixed the hang but LOST cross-turn context ("session=new"
// every turn). 1.4.180 restores persistence SAFELY: headless now STARTS with
// `--resume` when a session id exists, guarded by a fast first_token hang-probe that
// falls back to stateless (and marks the root non-resumable) if the resume hangs.
//
// This asserts the pure decision helpers (no process spawn):
//   decideGrokRunMode      — grok-tui+tmux → tmux path; else → headless path.
//   decideHeadlessGrokMode — headless launch choice: resume / new-persistent / stateless.
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

// --- decideHeadlessGrokMode: the headless launch choice (persistence restored) ---
ok('headless + stored session id → RESUME (persistent, pre-1.4.178 behavior)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, resumeBroken: false }), 'resume');
});
ok('headless + no session id → NEW-PERSISTENT (bootstrap a fresh named session)', () => {
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: false, resumeBroken: false }), 'new-persistent');
});
ok('headless + resume marked broken this run → STATELESS (skip the probe)', () => {
  // Once the hang-probe proved --resume broken this run, later turns must NOT pay
  // the ~90s probe again — go straight to the proven stateless invocation.
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: true, resumeBroken: true }), 'stateless');
  assert.strictEqual(decideHeadlessGrokMode({ hasSessionId: false, resumeBroken: true }), 'stateless');
});

console.log(`\ngrok-tui headless routing: ${pass} checks passed`);
