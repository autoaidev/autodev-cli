// Offline smoke — provider CONFIG GENERATION + SESSION RESOLUTION.
//
// Complements normalizer.parity.smoke.mjs (event-shape parity) and the
// liveNarration tests (streamed-bubble text) by locking down the *pure*
// config layer they don't touch:
//
//   1. The CLI command builders — the exact `claude` / `copilot` / `opencode`
//      shell strings each provider renders, including the model/session/title
//      flags and the load-bearing gotchas (single `-p` arg, opencode fresh runs
//      MUST NOT pass `-c/--continue`, `--name`/`--title` only on fresh sessions,
//      claude's `-1m` model-suffix stripping).
//   2. provider→CLI-binary mapping through the real ProviderRegistry: each of
//      the 3 CLI providers dispatches to its correct binary (claude-cli→claude,
//      copilot-cli→copilot, opencode-cli→opencode); registry id/label/kind
//      metadata is complete and consistent with PROVIDERS; unknown ids throw.
//   3. Session resolution — grok-tui resolves to the workspace's *stored* id
//      (undefined on a fresh root), and opencode's fresh-vs-resume flag logic.
//   4. Pure config helpers — claudeProjectFolder path encoding, parseWsUrl,
//      and the SETTINGS_DEFAULTS provider defaults.
//
// Fully offline / deterministic: no live server, no network, no CLI binaries
// spawned. A throwaway temp root is used only for the registry-dispatch and
// grok session-resolution checks. Run: node test/providerConfig.smoke.mjs
// (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildClaudeCliCommand, claudeProjectFolder } from '../out/providers/claudeCliProvider.js';
import { buildCopilotCliCommand } from '../out/providers/copilotCliProvider.js';
import { buildOpenCodeCliCommand } from '../out/providers/opencodeCliProvider.js';
import { providerRegistry } from '../out/core/provider/ProviderRegistry.js';
import { PROVIDERS } from '../out/providers.js';
import { SETTINGS_DEFAULTS, parseWsUrl } from '../out/core/settingsLoader.js';
import { getSessionId, saveSessionId } from '../out/sessionState.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const isWin = process.platform === 'win32';

function tmpRoot(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `autodev-pcfg-${tag}-`)));
}

const PROFILE = '/ws/.autodev/AGENT_PROFILE.md';
const MESSAGE = '/ws/.autodev/messages/task.md';
const COMBINED = '/ws/.autodev/messages/temp_1.md';

console.log('provider config / session resolution smoke');

// ---------------------------------------------------------------------------
// 1a. Claude CLI command builder
// ---------------------------------------------------------------------------
ok('claude-cli: fresh run — no --resume, no --model, profile+message in ONE -p arg', () => {
  const cmd = buildClaudeCliCommand(PROFILE, MESSAGE);
  assert.ok(cmd.startsWith('claude '), 'renders the claude binary');
  assert.ok(cmd.includes('--allow-dangerously-skip-permissions --dangerously-skip-permissions'));
  assert.ok(!cmd.includes('--resume'), 'fresh run passes no --resume');
  assert.ok(!cmd.includes('--model'), 'no model → no --model flag');
  // Both @file refs concatenated into a SINGLE quoted -p argument (claude drops
  // a second bare arg silently). The prompt token is one JSON string.
  assert.ok(cmd.includes(`-p ${JSON.stringify(`@${PROFILE} @${MESSAGE}`)}`),
    'profile + message combined into one quoted -p arg');
});

ok('claude-cli: sessionId → --resume, model → --model', () => {
  const cmd = buildClaudeCliCommand(PROFILE, MESSAGE, 'sess-123', true, 'opus');
  assert.ok(cmd.includes(' --resume sess-123'));
  assert.ok(cmd.includes(' --model opus'));
});

ok('claude-cli: -1m model suffix is stripped (case-insensitive)', () => {
  assert.ok(buildClaudeCliCommand(PROFILE, MESSAGE, undefined, true, 'sonnet-1m').includes(' --model sonnet'));
  assert.ok(!buildClaudeCliCommand(PROFILE, MESSAGE, undefined, true, 'sonnet-1m').includes('-1m'));
  // Case-insensitive suffix + preserves the rest of a compound id.
  const c = buildClaudeCliCommand(PROFILE, MESSAGE, undefined, true, 'claude-sonnet-4-1M');
  assert.ok(c.includes(' --model claude-sonnet-4'), c);
  assert.ok(!/-1m/i.test(c));
});

ok('claude-cli: includeProfile=false → message-only prompt, no profile ref', () => {
  const cmd = buildClaudeCliCommand(PROFILE, MESSAGE, undefined, false);
  assert.ok(cmd.includes(`-p ${JSON.stringify(`@${MESSAGE}`)}`));
  assert.ok(!cmd.includes(PROFILE), 'profile file not referenced when excluded');
});

// ---------------------------------------------------------------------------
// 1b. Copilot CLI command builder
// ---------------------------------------------------------------------------
ok('copilot-cli: fresh — autopilot flags, @file, no --resume/--model/--name', () => {
  const cmd = buildCopilotCliCommand(COMBINED);
  assert.ok(cmd.startsWith('copilot '), 'renders the copilot binary');
  for (const f of ['--autopilot', '--yolo', '--allow-all-tools', '--no-color', '--max-autopilot-continues 2000']) {
    assert.ok(cmd.includes(f), `missing flag ${f}`);
  }
  assert.ok(cmd.includes(`-p ${JSON.stringify(`@${COMBINED}`)}`));
  assert.ok(!cmd.includes('--resume'));
  assert.ok(!cmd.includes('--model'));
  assert.ok(!cmd.includes('--name'));
});

ok('copilot-cli: sessionId → --resume=<id>, model → --model=<model>', () => {
  const cmd = buildCopilotCliCommand(COMBINED, 'cop-9', 'gpt-5');
  assert.ok(cmd.includes(' --resume=cop-9'));
  assert.ok(cmd.includes(' --model=gpt-5'));
});

ok('copilot-cli: --name only titles a FRESH session, never a resume', () => {
  const fresh = buildCopilotCliCommand(COMBINED, undefined, undefined, 'My Task');
  assert.ok(fresh.includes(` --name ${JSON.stringify('My Task')}`), 'fresh session is named');
  const resumed = buildCopilotCliCommand(COMBINED, 'cop-9', undefined, 'My Task');
  assert.ok(!resumed.includes('--name'), 'resuming keeps the existing name (no --name)');
});

// ---------------------------------------------------------------------------
// 1c. OpenCode CLI command builder
// ---------------------------------------------------------------------------
ok('opencode-cli: fresh — `opencode run` + @file, NO -c/--continue, NO -s/--title', () => {
  const cmd = buildOpenCodeCliCommand(COMBINED);
  assert.ok(cmd.startsWith('opencode run'), 'renders `opencode run`');
  assert.ok(cmd.includes(JSON.stringify(`@${COMBINED}`)));
  // The documented gotcha: a fresh run must NOT continue the global last session.
  assert.ok(!/\s-c(\s|$)/.test(cmd) && !cmd.includes('--continue'), 'fresh run never passes -c/--continue');
  assert.ok(!cmd.includes(' -s '), 'fresh run passes no -s');
  assert.ok(!cmd.includes('--title'), 'fresh run without a name has no --title');
  assert.ok(!cmd.includes('--model'), 'no model → no --model');
});

ok('opencode-cli: sessionId → -s, model → --model (JSON-quoted), title only on fresh', () => {
  const resumed = buildOpenCodeCliCommand(COMBINED, 'oc-7', 'kimi/k2');
  assert.ok(resumed.includes(' -s oc-7'));
  assert.ok(resumed.includes(` --model ${JSON.stringify('kimi/k2')}`), 'model is JSON-quoted');
  const freshTitled = buildOpenCodeCliCommand(COMBINED, undefined, undefined, 'Nightly');
  assert.ok(freshTitled.includes(` --title ${JSON.stringify('Nightly')}`), 'fresh + name → --title');
  const resumedTitled = buildOpenCodeCliCommand(COMBINED, 'oc-7', undefined, 'Nightly');
  assert.ok(!resumedTitled.includes('--title'), 'resuming keeps prior title (no --title)');
});

// ---------------------------------------------------------------------------
// 2. provider → CLI-binary mapping through the REAL ProviderRegistry
// ---------------------------------------------------------------------------
const KIND = {
  'claude-cli': 'cli', 'claude-tui': 'tui',
  'copilot-cli': 'cli', 'copilot-sdk': 'sdk',
  'opencode-cli': 'cli', 'opencode-sdk': 'sdk',
  'grok-cli': 'cli', 'grok-tui': 'tui',
};

ok('registry: ids() covers exactly the 8 PROVIDERS, with consistent label/kind', () => {
  const ids = providerRegistry.ids().sort();
  assert.deepStrictEqual(ids, Object.keys(PROVIDERS).sort(), 'registry ids match PROVIDERS map');
  for (const id of ids) {
    const p = providerRegistry.get(id);
    assert.strictEqual(p.id, id);
    assert.strictEqual(p.label, PROVIDERS[id].label, `${id} label parity with PROVIDERS`);
    assert.strictEqual(p.kind, KIND[id], `${id} kind`);
  }
});

ok('registry: get() on an unknown id throws; has() is honest', () => {
  assert.throws(() => providerRegistry.get('nope-cli'), /No provider registered/);
  assert.strictEqual(providerRegistry.has('claude-cli'), true);
  assert.strictEqual(providerRegistry.has('nope-cli'), false);
});

ok('registry dispatch: each CLI provider maps to its correct binary', async () => {
  const root = tmpRoot('dispatch');
  const baseReq = (over) => ({
    root,
    agentProfileFile: PROFILE,
    messageFile: MESSAGE,
    combinedFile: COMBINED,
    resolvedSessionId: undefined,
    includeProfile: true,
    // hooksEnabled:false keeps the command free of the synthetic-hook wrapper so
    // we assert the raw provider binary; no copilot token → no env mutation.
    settings: { ...SETTINGS_DEFAULTS, hooksEnabled: false },
    stdoutFile: path.join(root, 'out.log'),
    exitFile: path.join(root, 'exit.code'),
    ...over,
  });
  const ctx = { log: () => {}, launcher: {}, showOutput: () => {} };

  const claude = await providerRegistry.get('claude-cli').dispatch(baseReq(), ctx);
  assert.ok(claude.command.includes('claude '), 'claude-cli → claude binary');

  const copilot = await providerRegistry.get('copilot-cli').dispatch(baseReq(), ctx);
  assert.ok(copilot.command.includes('copilot '), 'copilot-cli → copilot binary');

  const opencode = await providerRegistry.get('opencode-cli').dispatch(baseReq(), ctx);
  assert.ok(opencode.command.includes('opencode run'), 'opencode-cli → opencode run');

  // All CLI dispatches tee stdout + capture exit code (deterministic on POSIX).
  if (!isWin) {
    for (const o of [claude, copilot, opencode]) {
      assert.ok(o.command.includes('| tee '), 'stdout teed');
      assert.ok(o.command.includes('echo $? >'), 'exit code captured');
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Session resolution
// ---------------------------------------------------------------------------
ok('session resolution: grok-tui resolves to the workspace stored id (undefined when fresh)', async () => {
  const root = tmpRoot('grok');
  const grokTui = providerRegistry.get('grok-tui');
  assert.strictEqual(await grokTui.resolveSession(root, () => {}), undefined,
    'fresh workspace → no stored grok-tui session');
  saveSessionId(root, 'grok-tui', 'grok-abc');
  assert.strictEqual(getSessionId(root, 'grok-tui'), 'grok-abc');
  assert.strictEqual(await grokTui.resolveSession(root, () => {}), 'grok-abc',
    'resolveSession returns the stored id — context carries across tasks');
  // Session store is provider-scoped: a different provider key is independent.
  assert.strictEqual(getSessionId(root, 'opencode-cli'), undefined);
});

// ---------------------------------------------------------------------------
// 4. Pure config helpers
// ---------------------------------------------------------------------------
ok('claudeProjectFolder: encodes / : \\ to -, collapses runs, keeps leading, drops trailing dash', () => {
  assert.strictEqual(claudeProjectFolder('/home/x/foo'), '-home-x-foo');
  assert.strictEqual(claudeProjectFolder('/home//x/foo/'), '-home-x-foo');
  assert.strictEqual(claudeProjectFolder('C:\\Users\\a'), 'C-Users-a');
});

ok('parseWsUrl: splits token/endpoint out of the WS URL; base keeps scheme+path', () => {
  const r = parseWsUrl('wss://host.example/ws?token=SECRET&endpoint=slug-1');
  assert.deepStrictEqual(r, { serverBaseUrl: 'wss://host.example/ws', serverApiKey: 'SECRET', webhookSlug: 'slug-1' });
  assert.strictEqual(parseWsUrl(''), null, 'empty → null');
  assert.strictEqual(parseWsUrl('https://host/ws'), null, 'non-WS scheme → null');
  const noQs = parseWsUrl('ws://h/ws');
  assert.deepStrictEqual(noQs, { serverBaseUrl: 'ws://h/ws', serverApiKey: '', webhookSlug: '' });
});

ok('SETTINGS_DEFAULTS: sane provider defaults (main claude-tui, fallback opencode-cli, off)', () => {
  assert.strictEqual(SETTINGS_DEFAULTS.provider, 'claude-tui');
  assert.strictEqual(SETTINGS_DEFAULTS.fallbackProvider, 'opencode-cli');
  assert.strictEqual(SETTINGS_DEFAULTS.fallbackProviderEnabled, false);
  assert.strictEqual(SETTINGS_DEFAULTS.hooksEnabled, false);
  // Every provider default must be a registered provider id.
  assert.ok(providerRegistry.has(SETTINGS_DEFAULTS.provider));
  assert.ok(providerRegistry.has(SETTINGS_DEFAULTS.fallbackProvider));
});

console.log(`\n✅ providerConfig smoke: ${pass} checks passed`);
