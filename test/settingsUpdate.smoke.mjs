// Offline smoke — the remote `settings_update` WS frame.
//
// pixel-office sends exactly:
//     { "type": "settings_update", "settings": { "mcpUpdateEnabled": true, ... } }
// to flip the mcpUpdateEnabled / skillUpdateEnabled opt-in gates live, so an
// office-pushed MCP/skill config is no longer silently ignored (both default
// false and were local-opt-in only). The frame is intentionally ungated — it IS
// the switch for those gates — so the safety is a STRICT boolean whitelist:
// only those two keys, coerced to real booleans, can ever be written. This
// locks the whitelist + the crash-safe persist/merge that backs the handler.
//
// Run: node test/settingsUpdate.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  loadSettingsForRoot,
  mergeSettingsForRoot,
  whitelistRemoteSettingsUpdate,
  REMOTE_SETTINGS_UPDATE_WHITELIST,
} = await import('../out/core/settingsLoader.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function workspace(settings) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-setupd-')));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
    fs.writeFileSync(path.join(d, '.autodev', 'settings.json'), JSON.stringify(settings, null, 2));
  }
  return d;
}
const readRaw = (d) => JSON.parse(fs.readFileSync(path.join(d, '.autodev', 'settings.json'), 'utf8'));

// Mirror of the production handler body (taskLoop._handleSettingsUpdate /
// mcpOperate.handleSettingsUpdate): whitelist → persist → apply live. `live` is
// the in-memory settings object the running loop keeps in `this._settings`.
function applySettingsUpdateFrame(root, frameSettings, live) {
  const whitelisted = whitelistRemoteSettingsUpdate(frameSettings);
  if (Object.keys(whitelisted).length === 0) { return whitelisted; }
  mergeSettingsForRoot(root, whitelisted);
  Object.assign(live, whitelisted); // live-apply, no restart
  return whitelisted;
}

console.log('settings_update frame smoke');

// ---------------------------------------------------------------------------
// (a) settings_update sets mcpUpdateEnabled true; it persists to settings.json
//     AND takes effect on a subsequent mcp_update — WITHOUT a restart.
// ---------------------------------------------------------------------------
ok('mcpUpdateEnabled:true persists to disk and flips the live gate (no restart)', () => {
  const d = workspace({ mcpUpdateEnabled: false, skillUpdateEnabled: false });
  // The running loop's in-memory settings start from disk (both gates off).
  const live = loadSettingsForRoot(d);
  assert.strictEqual(live.mcpUpdateEnabled, false);

  // Office pushes exactly the documented frame's `settings` object.
  applySettingsUpdateFrame(d, { mcpUpdateEnabled: true }, live);

  // Persisted to disk (survives a restart).
  assert.strictEqual(readRaw(d).mcpUpdateEnabled, true, 'must persist to settings.json');
  assert.strictEqual(loadSettingsForRoot(d).mcpUpdateEnabled, true, 'a fresh load (restart) sees it');

  // Live-applied: the SAME gate a subsequent mcp_update frame checks
  // (`this._settings.mcpUpdateEnabled`) is now true — no restart needed.
  assert.strictEqual(live.mcpUpdateEnabled, true, 'subsequent mcp_update would now be honored live');
});

// ---------------------------------------------------------------------------
// (b) Non-whitelisted keys are ignored (never reach settings.json).
// ---------------------------------------------------------------------------
ok('non-whitelisted keys (serverApiKey, provider, paths…) are dropped', () => {
  const d = workspace({ serverApiKey: 'KEEP', provider: 'claude-tui' });
  const live = loadSettingsForRoot(d);
  applySettingsUpdateFrame(d, {
    mcpUpdateEnabled: true,
    serverApiKey: 'EVIL',
    provider: 'dummy',
    wsUrl: 'wss://evil/ws',
    profilePath: '/etc/passwd',
  }, live);

  const raw = readRaw(d);
  assert.strictEqual(raw.mcpUpdateEnabled, true, 'the whitelisted key is written');
  assert.strictEqual(raw.serverApiKey, 'KEEP', 'a remote frame must NOT overwrite serverApiKey');
  assert.strictEqual(raw.provider, 'claude-tui', 'a remote frame must NOT change the provider');
  assert.ok(!('wsUrl' in raw), 'a non-whitelisted key must never be introduced');
  assert.ok(!('profilePath' in raw), 'a non-whitelisted key must never be introduced');
});

// ---------------------------------------------------------------------------
// (c) Non-boolean values are coerced to a strict boolean (=== true).
// ---------------------------------------------------------------------------
ok('non-boolean values coerce with === true (never a truthy string)', () => {
  const w = whitelistRemoteSettingsUpdate({ mcpUpdateEnabled: 'true', skillUpdateEnabled: 1 });
  assert.strictEqual(w.mcpUpdateEnabled, false, 'the string "true" is NOT true');
  assert.strictEqual(w.skillUpdateEnabled, false, 'the number 1 is NOT true');
  assert.strictEqual(typeof w.mcpUpdateEnabled, 'boolean');

  const t = whitelistRemoteSettingsUpdate({ mcpUpdateEnabled: true });
  assert.strictEqual(t.mcpUpdateEnabled, true, 'a real boolean true passes through');
  assert.ok(!('skillUpdateEnabled' in t), 'an absent key stays absent (distinct from false)');
});

// ---------------------------------------------------------------------------
// (d) The merge preserves every OTHER existing settings key.
// ---------------------------------------------------------------------------
ok('merge preserves all other existing settings keys', () => {
  const d = workspace({
    wsUrl: 'wss://office.example/ws?token=agt_X&endpoint=slug-x',
    provider: 'claude-tui',
    gitEnabled: true,
    mcpServers: { foo: { command: 'x', args: ['y'] } },
    skillUpdateEnabled: false,
  });
  mergeSettingsForRoot(d, { mcpUpdateEnabled: true, skillUpdateEnabled: true });

  const raw = readRaw(d);
  assert.strictEqual(raw.mcpUpdateEnabled, true);
  assert.strictEqual(raw.skillUpdateEnabled, true, 'an existing whitelisted key is overwritten');
  assert.strictEqual(raw.wsUrl, 'wss://office.example/ws?token=agt_X&endpoint=slug-x', 'wsUrl preserved');
  assert.strictEqual(raw.provider, 'claude-tui', 'provider preserved');
  assert.strictEqual(raw.gitEnabled, true, 'gitEnabled preserved');
  assert.deepStrictEqual(raw.mcpServers, { foo: { command: 'x', args: ['y'] } }, 'mcpServers preserved');
});

// ---------------------------------------------------------------------------
// Edge cases: empty/unknown-only frames are graceful no-ops; missing file OK.
// ---------------------------------------------------------------------------
ok('an unknown-keys-only frame makes no change (graceful no-op)', () => {
  const d = workspace({ mcpUpdateEnabled: false });
  const live = loadSettingsForRoot(d);
  const applied = applySettingsUpdateFrame(d, { somethingElse: true }, live);
  assert.strictEqual(Object.keys(applied).length, 0, 'nothing whitelisted → nothing applied');
  assert.strictEqual(readRaw(d).mcpUpdateEnabled, false, 'disk unchanged');
  assert.strictEqual(live.mcpUpdateEnabled, false, 'live gate unchanged');
});

ok('merge creates .autodev/ when the workspace has no settings file yet', () => {
  const d = workspace(undefined); // no .autodev/
  mergeSettingsForRoot(d, { mcpUpdateEnabled: true });
  assert.strictEqual(readRaw(d).mcpUpdateEnabled, true, 'file + dir created and written');
});

ok('the whitelist is exactly the two documented keys', () => {
  assert.deepStrictEqual([...REMOTE_SETTINGS_UPDATE_WHITELIST].sort(),
    ['mcpUpdateEnabled', 'skillUpdateEnabled']);
});

console.log(`\n${pass} checks passed`);
