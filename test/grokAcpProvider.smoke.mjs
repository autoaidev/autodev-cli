// Offline smoke — grok-acp is a first-class provider (1.4.196): it is in the
// PROVIDERS map + ProviderId union, the registry returns a GrokAcpProvider with
// id 'grok-acp', and that provider is wired to the grok family (events,
// normalizer, model key) and the persistent ACP launch (GROK_ACP_SPEC). No live
// grok is started — we assert the WIRING only.
//
// Run: node test/grokAcpProvider.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { PROVIDERS } = await import('../out/providers.js');
const { providerRegistry } = await import('../out/core/provider/ProviderRegistry.js');
const { GrokAcpProvider } = await import('../out/providers/base/implementations.js');
const { GROK_ACP_SPEC, GrokAcpSession } = await import('../out/providers/grok/GrokAcpSession.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grokAcpProvider: grok-acp first-class provider wiring');

// --- PROVIDERS map entry ---
ok("PROVIDERS['grok-acp'] exists with a label", () => {
  assert.ok(PROVIDERS['grok-acp'], "PROVIDERS['grok-acp'] missing");
  assert.equal(PROVIDERS['grok-acp'].label, 'Grok ACP');
  assert.equal(PROVIDERS['grok-acp'].isCli, true);
});

// --- registry returns a GrokAcpProvider ---
ok("registry resolves 'grok-acp' to a GrokAcpProvider", () => {
  assert.ok(providerRegistry.has('grok-acp'), "registry has no 'grok-acp'");
  const p = providerRegistry.get('grok-acp');
  assert.ok(p instanceof GrokAcpProvider, 'not a GrokAcpProvider instance');
  assert.equal(p.id, 'grok-acp');
  assert.equal(p.family, 'grok');
  assert.equal(p.kind, 'sdk'); // persistent in-process session (not cli/tui)
  assert.ok(providerRegistry.ids().includes('grok-acp'));
});

// --- grok family reuse: events + normalizer carry the 'grok-acp' id ---
ok('reuses grok events + normalizer with provider id grok-acp', () => {
  const p = providerRegistry.get('grok-acp');
  assert.equal(p.events.provider, 'grok-acp');
  assert.equal(p.normalizer.provider, 'grok-acp');
  // model key keys off the 'grok' prefix → grokModel; same model catalog as grok.
  assert.ok(p.models.list().some(m => m.id.startsWith('grok')));
});

// --- persistent ACP launch: GROK_ACP_SPEC + GrokAcpSession are the transport ---
ok('builds a GrokAcpSession over GROK_ACP_SPEC (grok agent … stdio)', () => {
  const args = GROK_ACP_SPEC.buildArgs('grok-4', []);
  assert.equal(args[0], 'agent');
  assert.ok(args.includes('--always-approve'));
  assert.ok(args.includes('-m') && args.includes('grok-4'));
  assert.equal(args[args.length - 1], 'stdio');
  assert.equal(GROK_ACP_SPEC.authRequired, true);
  // A GrokAcpSession can be constructed with that spec without launching grok.
  const sess = new GrokAcpSession({ root: '/tmp/nope', bin: 'grok', hooks: { emitHook() {}, log() {} } });
  assert.ok(sess instanceof GrokAcpSession);
  assert.equal(sess.isAlive(), false); // not spawned
});

console.log(`\ngrokAcpProvider: ${pass} checks passed`);
