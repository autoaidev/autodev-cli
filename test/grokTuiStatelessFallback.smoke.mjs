// Offline smoke — grok-tui degrades to the STATELESS path when tmux is absent.
//
// ROOT CAUSE (proven by live repro): grok-tui runs a persistent session via
// `grok --resume <sid> --prompt-file`. grok 1.0.41's HEADLESS `--resume` never
// completes the turn → 10-min watchdog → SIGKILL → false StopFailure → retry
// forever (hang on Windows, which has no tmux). grok-cli (stateless, no --resume)
// works on the same box.
//
// FIX: without tmux, grok-tui must run STATELESS (persist:false → no
// --resume/--session-id), exactly grok-cli's working invocation. The persistent
// model is only reliable with a live tmux pane.
//
// This asserts the pure decision helper decideGrokRunMode:
//   grok-tui + no tmux → stateless (persist:false, no tmux)
//   grok-tui + tmux    → persistent tmux path (useTmux:true)
//   grok-cli           → stateless (persist:false, never tmux)
//
// Run: node test/grokTuiStatelessFallback.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { decideGrokRunMode } = await import('../out/providers/grok/tui.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grok-tui: stateless fallback when tmux unavailable');

ok('grok-tui + NO tmux → stateless (persist:false, no --resume path)', () => {
  const m = decideGrokRunMode({ tmuxAvailable: false, providerId: 'grok-tui' });
  assert.strictEqual(m.useTmux, false, 'must not use tmux when tmux is absent');
  assert.strictEqual(m.persist, false, 'headless grok-tui must be stateless (no --resume/--session-id)');
});

ok('grok-tui + tmux → persistent tmux path (useTmux:true)', () => {
  const m = decideGrokRunMode({ tmuxAvailable: true, providerId: 'grok-tui' });
  assert.strictEqual(m.useTmux, true, 'grok-tui stays persistent where tmux exists');
  assert.strictEqual(m.persist, true);
});

ok('grok-cli → stateless regardless of tmux (never uses tmux)', () => {
  const noTmux = decideGrokRunMode({ tmuxAvailable: false, providerId: 'grok-cli' });
  const withTmux = decideGrokRunMode({ tmuxAvailable: true, providerId: 'grok-cli' });
  assert.strictEqual(noTmux.useTmux, false);
  assert.strictEqual(noTmux.persist, false);
  assert.strictEqual(withTmux.useTmux, false, 'grok-cli never routes through the tmux persistent path');
  assert.strictEqual(withTmux.persist, false);
});

console.log(`\ngrok-tui stateless fallback: ${pass} checks passed`);
