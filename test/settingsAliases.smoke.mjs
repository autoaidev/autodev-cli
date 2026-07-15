// Offline smoke — the hand-written settings keys the docs tell users to use.
//
// The office's "Manual (raw creds)" instructions (AgentConnectCommands.vue and
// docs/CONNECT-A-LOCAL-AGENT.md) have long said to write:
//     { "officeWsUrl": ..., "apiKey": ..., "slug": ... }
// The loader only ever read wsUrl / serverApiKey / webhookSlug. So following the
// documented steps produced a settings.json the CLI SILENTLY ignored: no binding,
// no office, and no error — the agent just sat there looking fine. Verified: all
// three fields came back "" from exactly the documented shape.
//
// The aliases repair every settings.json already written from those instructions.
// This locks that, and the precedence that keeps it safe.
// Run: node test/settingsAliases.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadSettingsForRoot } = await import('../out/core/settingsLoader.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function workspace(settings) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-alias-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, '.autodev', 'settings.json'), JSON.stringify(settings, null, 2));
  return d;
}

console.log('settings alias smoke');

// ---------------------------------------------------------------------------
// 1. The documented shape must actually bind — this is the whole bug.
// ---------------------------------------------------------------------------
ok('the documented keys (officeWsUrl/apiKey/slug) bind the agent', () => {
  const s = loadSettingsForRoot(workspace({
    officeWsUrl: 'wss://office.example/ws?token=agt_KEY&endpoint=my-agent',
    apiKey: 'agt_KEY',
    slug: 'my-agent',
  }));
  assert.ok(s.wsUrl, 'officeWsUrl must populate wsUrl — otherwise the agent never connects');
  assert.strictEqual(s.serverApiKey, 'agt_KEY', 'apiKey must populate serverApiKey');
  assert.strictEqual(s.webhookSlug, 'my-agent', 'slug must populate webhookSlug');
});

// ---------------------------------------------------------------------------
// 2. Precedence: an alias must never override an explicit canonical value.
// ---------------------------------------------------------------------------
ok('canonical wsUrl wins over the officeWsUrl alias', () => {
  const s = loadSettingsForRoot(workspace({
    wsUrl: 'wss://canonical/ws',
    officeWsUrl: 'wss://alias/ws',
  }));
  assert.strictEqual(s.wsUrl, 'wss://canonical/ws', 'an alias must not clobber an explicit wsUrl');
});

// NB: serverApiKey/webhookSlug are asserted WITHOUT a wsUrl present. That is not
// avoidance — when wsUrl is set, loadSettingsForRoot deliberately DERIVES those
// two from it and overwrites whatever was there ("wsUrl takes priority", long
// predating aliases). Mixing them would test that rule, not this one.
ok('canonical serverApiKey/webhookSlug win over their aliases', () => {
  const s = loadSettingsForRoot(workspace({
    serverApiKey: 'CANON',
    apiKey: 'ALIAS',
    webhookSlug: 'canon-slug',
    slug: 'alias-slug',
  }));
  assert.strictEqual(s.serverApiKey, 'CANON', 'an alias must not clobber an explicit serverApiKey');
  assert.strictEqual(s.webhookSlug, 'canon-slug', 'an alias must not clobber an explicit webhookSlug');
});

ok('wsUrl still takes priority over the apiKey alias (pre-existing derivation)', () => {
  const s = loadSettingsForRoot(workspace({
    wsUrl: 'wss://office.example/ws?token=agt_FROM_URL&endpoint=from-url',
    apiKey: 'ALIAS_KEY',
  }));
  assert.strictEqual(s.serverApiKey, 'agt_FROM_URL', 'a wsUrl-derived key must still win — aliases do not change that');
});

// ---------------------------------------------------------------------------
// 3. Canonical-only configs (the overwhelming majority) are untouched.
// ---------------------------------------------------------------------------
ok('canonical-only settings behave exactly as before', () => {
  const s = loadSettingsForRoot(workspace({
    wsUrl: 'wss://office.example/ws?token=agt_X&endpoint=slug-x',
  }));
  assert.strictEqual(s.serverApiKey, 'agt_X', 'wsUrl still derives the legacy fields');
  assert.strictEqual(s.webhookSlug, 'slug-x');
});

// ---------------------------------------------------------------------------
// 4. Junk must not bind. An empty/wrong-typed alias is not a credential.
// ---------------------------------------------------------------------------
ok('empty or non-string aliases are ignored', () => {
  const s = loadSettingsForRoot(workspace({ officeWsUrl: '', apiKey: 123, slug: null }));
  assert.strictEqual(s.wsUrl, '', 'an empty alias must not set a value');
  assert.strictEqual(s.serverApiKey, '', 'a non-string alias must be ignored');
  assert.strictEqual(s.webhookSlug, '', 'a null alias must be ignored');
});

ok('a workspace with no settings file still returns defaults', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-alias-none-')));
  const s = loadSettingsForRoot(d);
  assert.strictEqual(s.wsUrl, '');
  assert.strictEqual(s.serverApiKey, '');
});

console.log(`\n${pass} checks passed`);
