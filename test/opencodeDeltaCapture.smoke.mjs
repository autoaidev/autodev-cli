// Offline smoke — opencode delta capture on the fallback path (1.4.194 FIX 3A).
//
// The createOpencode-server FALLBACK path (AUTODEV_OPENCODE_ACP=0) drained the
// event stream waiting only for `message.part.updated` — but opencode 1.14.22
// streams assistant text via `message.part.delta` with field:'text'. Result: the
// fallback returned EMPTY stdout and the loop read a blank turn. The fix routes
// BOTH shapes through one shared extractor (extractOpencodeDeltaText), used by the
// fallback prompt loop AND the background narrator so they can never drift again.
// Run: node test/opencodeDeltaCapture.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { extractOpencodeDeltaText } = await import('../out/providers/opencode/sdk.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('opencode sdk: assistant-text extractor handles both wire shapes');

ok('opencode 1.14.22 shape: message.part.delta(field:text) → captured', () => {
  const text = extractOpencodeDeltaText('message.part.delta', { field: 'text', delta: 'hello world' });
  assert.strictEqual(text, 'hello world', 'the 1.14.22 delta event is captured (was previously dropped → empty stdout)');
});

ok('legacy ≤1.13 shape: message.part.updated(delta) → captured', () => {
  const text = extractOpencodeDeltaText('message.part.updated', { delta: 'legacy chunk' });
  assert.strictEqual(text, 'legacy chunk', 'the older updated event is still captured');
});

ok('non-text delta field is ignored (no spurious text)', () => {
  assert.strictEqual(extractOpencodeDeltaText('message.part.delta', { field: 'reasoning', delta: 'thinking' }), '', 'a non-text field does not leak into assistant stdout');
  assert.strictEqual(extractOpencodeDeltaText('message.part.delta', { field: undefined, delta: 'x' }), '', 'a missing field is treated as non-text');
});

ok('unrelated event types return empty', () => {
  assert.strictEqual(extractOpencodeDeltaText('session.idle', {}), '');
  assert.strictEqual(extractOpencodeDeltaText('tool.execute.before', { delta: 'nope' }), '');
  assert.strictEqual(extractOpencodeDeltaText(undefined, undefined), '');
});

ok('missing delta yields empty (no crash on partial payloads)', () => {
  assert.strictEqual(extractOpencodeDeltaText('message.part.delta', { field: 'text' }), '');
  assert.strictEqual(extractOpencodeDeltaText('message.part.updated', {}), '');
});

console.log(`\n${pass} assertions passed ✓`);
