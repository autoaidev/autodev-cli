// Offline smoke — the headless grok-tui resume hang-probe decision.
//
// grok 1.0.41's HEADLESS `grok --resume` can LOAD a session (stays alive, writes
// turn_started / phase_changed) yet never answer → the 10-min watchdog → false
// StopFailure. 1.4.180 restores persistent resume behind a FAST probe: after
// launching `--resume`, watch grok's events.jsonl for a `first_token` (proof the
// resumed prompt is being processed) within AUTODEV_GROK_RESUME_PROBE_MS. Seen in
// time → let the turn run (persistent); not seen → kill grok + relaunch stateless.
//
// This locks the two PURE pieces that make the probe testable without a process:
//   scanGrokFirstToken   — detect the first_token event in tailed events.jsonl lines
//   resumeProbeVerdict   — ok (first_token) / fallback (window elapsed) / wait (neither)
//
// Run: node test/grokResumeProbe.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { resumeProbeVerdict } = await import('../out/providers/grok/tui.js');
const { scanGrokFirstToken } = await import('../out/core/grokEvents.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grok resume-probe: scanGrokFirstToken + resumeProbeVerdict');

// Real event lines from a grok session events.jsonl dump.
const firstToken = '{"ts":"2026-07-25T11:14:01.687Z","type":"first_token"}';
const turnStarted = '{"ts":"2026-08-05T10:32:26.521Z","type":"turn_started","turn_number":0,"model_id":"grok-4.5"}';
const phaseWaiting = '{"ts":"2026-08-05T10:32:26.623Z","type":"phase_changed","phase":"waiting_for_model"}';

// --- scanGrokFirstToken: only a real first_token event counts as "grok is answering" ---
ok('scanGrokFirstToken: true only when a first_token event is present', () => {
  assert.strictEqual(scanGrokFirstToken([firstToken]), true);
  assert.strictEqual(scanGrokFirstToken([turnStarted, phaseWaiting, firstToken]), true);
  // The HANG signature: alive (turn_started/phase_changed) but NO first_token.
  assert.strictEqual(scanGrokFirstToken([turnStarted, phaseWaiting]), false);
  assert.strictEqual(scanGrokFirstToken([]), false);
  assert.strictEqual(scanGrokFirstToken(['not json', '{"type":"other"}']), false);
  // Accepts parsed objects too (pure, no I/O).
  assert.strictEqual(scanGrokFirstToken([{ type: 'first_token' }]), true);
});

// --- resumeProbeVerdict: ok / fallback / wait ---
ok('first_token seen before the window → "ok" (let the persistent turn run)', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: true, elapsedMs: 1000, probeMs: 90000 }), 'ok');
  // ok wins even at/after the deadline — a first_token is proof regardless of time.
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: true, elapsedMs: 90000, probeMs: 90000 }), 'ok');
});
ok('window elapsed with NO first_token and NO new events → "fallback" (the hang)', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 90000, probeMs: 90000 }), 'fallback');
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 90001, probeMs: 90000 }), 'fallback');
  // Explicit no-growth is the same as the default (back-compat preserved).
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 90000, probeMs: 90000, grewSinceSeed: false }), 'fallback');
});
// Tolerant probe (1.4.184): a resume that LOADED and is actively writing session
// events (large session still streaming / a tool call before first text) is NOT the
// loaded-but-idle hang → grant ONE grace window instead of killing a healthy resume.
ok('window elapsed, no first_token, but grok WROTE events → "extend" (once)', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 90000, probeMs: 90000, grewSinceSeed: true }), 'extend');
  // The grace is offered only once — after extending, a still-silent window falls back.
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 90000, probeMs: 90000, grewSinceSeed: true, alreadyExtended: true }), 'fallback');
});
ok('a first_token still wins even when events grew (no needless extend)', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: true, elapsedMs: 90000, probeMs: 90000, grewSinceSeed: true }), 'ok');
});
ok('neither yet (window not elapsed, no first_token) → "wait"', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 5000, probeMs: 90000 }), 'wait');
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 0, probeMs: 90000 }), 'wait');
});
ok('probeMs <= 0 disables the deadline → "wait" until first_token', () => {
  assert.strictEqual(resumeProbeVerdict({ sawFirstToken: false, elapsedMs: 999999, probeMs: 0 }), 'wait');
});

console.log(`\ngrok resume-probe smoke: ${pass} checks passed`);
