// Offline smoke — GLOBAL cross-provider session discovery + normalized reading.
//
// Locks down the pure, machine-independent contract of sessionsGlobal (the
// module the autodev-app Sessions tab shells to via `sessions --all --json`
// and `session-show`):
//
//   1. normalizeSessionProvider maps every fine-grained provider id onto its
//      canonical family (grok-tui→grok, claude-cli→claude, …) and returns
//      undefined for "all"/unknown.
//   2. collectAllSessions() never throws and yields the normalized shape
//      (provider ∈ {claude,grok,opencode,copilot}, id/name/cwd/updated), sorted
//      newest-first — whatever real stores happen to exist on this box.
//   3. A per-family filter only ever returns that family.
//   4. readSessionTranscript on a non-existent id degrades to [] (never throws)
//      for every provider, and its output shape is a role/text message array.
//
// Fully offline / deterministic: reads only whatever real stores exist (may be
// none — then the arrays are empty, which is still a valid pass). No network,
// no CLI binaries spawned. Run: node test/sessionsGlobal.smoke.mjs (after build).
import assert from 'node:assert';
import {
  collectAllSessions,
  readSessionTranscript,
  normalizeSessionProvider,
} from '../out/sessionsGlobal.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok: ${msg}`); passed++; };

// 1) provider normalization
ok(normalizeSessionProvider('claude-cli') === 'claude', 'claude-cli → claude');
ok(normalizeSessionProvider('claude-tui') === 'claude', 'claude-tui → claude');
ok(normalizeSessionProvider('grok-tui') === 'grok', 'grok-tui → grok');
ok(normalizeSessionProvider('opencode-sdk') === 'opencode', 'opencode-sdk → opencode');
ok(normalizeSessionProvider('copilot-cli') === 'copilot', 'copilot-cli → copilot');
ok(normalizeSessionProvider(undefined) === undefined, 'undefined → undefined (all)');
ok(normalizeSessionProvider('nope') === undefined, 'unknown → undefined');

// 2) global discovery: normalized shape, never throws, newest-first
const all = collectAllSessions();
ok(Array.isArray(all), 'collectAllSessions() returns an array');
const families = new Set(['claude', 'grok', 'opencode', 'copilot']);
for (const s of all) {
  assert.ok(families.has(s.provider), `bad provider: ${s.provider}`);
  assert.strictEqual(typeof s.id, 'string');
  assert.strictEqual(typeof s.name, 'string');
  assert.strictEqual(typeof s.cwd, 'string');
  assert.strictEqual(typeof s.updated, 'number');
}
ok(true, `every session has the normalized shape (${all.length} found)`);
let sorted = true;
for (let i = 1; i < all.length; i++) { if (all[i - 1].updated < all[i].updated) { sorted = false; break; } }
ok(sorted, 'sessions are sorted newest-first');

// 3) per-family filter only returns that family
for (const fam of families) {
  const only = collectAllSessions(fam);
  assert.ok(only.every((s) => s.provider === fam), `filter ${fam} leaked another provider`);
}
ok(true, 'per-family filter returns only that family');

// 4) transcript reader on a bogus id degrades to [] for every provider
for (const fam of families) {
  const msgs = readSessionTranscript(fam, 'does-not-exist-0000', {});
  assert.ok(Array.isArray(msgs) && msgs.length === 0, `${fam} bogus id should be []`);
}
ok(true, 'readSessionTranscript on a missing id is [] for every provider');

// message shape: read a real session (if any) and validate role/text
const first = all[0];
if (first) {
  const msgs = readSessionTranscript(first.provider, first.id, { file: first.file, cwd: first.cwd, limit: 50 });
  assert.ok(Array.isArray(msgs), 'transcript is an array');
  for (const m of msgs) {
    assert.ok(['user', 'assistant', 'system', 'tool'].includes(m.role), `bad role: ${m.role}`);
    assert.strictEqual(typeof m.text, 'string');
  }
  ok(true, `real ${first.provider} transcript has valid message shapes (${msgs.length} msgs)`);
} else {
  ok(true, 'no real sessions on this box — skipped live transcript read');
}

console.log(`\nsessionsGlobal.smoke: ${passed} assertions passed`);
