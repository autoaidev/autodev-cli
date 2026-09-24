// Offline smoke — FIX 1: `removeCozempicHooks` must strip cozempic hooks from the
// GLOBAL user settings (`~/.claude/settings.json`) too, not only the project
// `<root>/.claude/settings.local.json`. A user who disabled cozempic still had a
// global SessionStart hook firing (grok: "session_start hook (global/settings)
// failed, ignored: exit code 1" on Windows), because the reconcile only touched
// the project file.
//
// Run: node test/cozempicHooks.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { removeCozempicHooks, removeCozempicHooksFromFile } = require('../out/cozempicHooks.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
// A cozempic-installed SessionStart hook (canonical schema tag) + an unrelated hook.
function settingsWithCozempicAnd(unrelatedCmd) {
  return {
    someOtherSetting: 'keep-me',
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [
          { type: 'command', command: 'cozempic session-start # cozempic-hook-schema=v1' },
        ] },
      ],
      PostToolUse: [
        { matcher: 'Bash', hooks: [
          { type: 'command', command: unrelatedCmd },
        ] },
      ],
    },
  };
}

console.log('cozempicHooks smoke');

// ── FIX 1: global ~/.claude/settings.json cozempic hook is stripped along with the
//    project settings.local.json one, while unrelated hooks + settings survive. ──
ok('removeCozempicHooks strips BOTH the project file and the GLOBAL ~/.claude/settings.json', () => {
  const home = tmp('cozempic-home-');
  const projectRoot = tmp('cozempic-proj-');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    // Override HOME so os.homedir() resolves into our sandbox (Linux honors HOME).
    process.env.HOME = home;
    process.env.USERPROFILE = home; // belt & braces (Windows)
    assert.strictEqual(os.homedir(), home, 'precondition: os.homedir() must honor HOME in this env');

    const globalPath = path.join(home, '.claude', 'settings.json');
    const projectPath = path.join(projectRoot, '.claude', 'settings.local.json');
    writeJson(globalPath, settingsWithCozempicAnd('echo global-unrelated'));
    writeJson(projectPath, settingsWithCozempicAnd('echo project-unrelated'));

    const changed = removeCozempicHooks(projectRoot);
    assert.strictEqual(changed, true, 'must report a change (both files had cozempic hooks)');

    // GLOBAL file: cozempic SessionStart gone, unrelated PostToolUse survives.
    const g = readJson(globalPath);
    assert.strictEqual(g.someOtherSetting, 'keep-me', 'global: unrelated setting preserved');
    assert.ok(!g.hooks?.SessionStart, 'global: cozempic-only SessionStart group pruned');
    assert.strictEqual(
      g.hooks.PostToolUse[0].hooks[0].command, 'echo global-unrelated',
      'global: unrelated hook survives',
    );
    assert.ok(!JSON.stringify(g).includes('cozempic'), 'global: no cozempic residue');

    // PROJECT file: cozempic SessionStart gone, unrelated PostToolUse survives.
    const p = readJson(projectPath);
    assert.ok(!p.hooks?.SessionStart, 'project: cozempic-only SessionStart group pruned');
    assert.strictEqual(
      p.hooks.PostToolUse[0].hooks[0].command, 'echo project-unrelated',
      'project: unrelated hook survives',
    );
    assert.ok(!JSON.stringify(p).includes('cozempic'), 'project: no cozempic residue');

    // Idempotent — a second pass changes nothing.
    assert.strictEqual(removeCozempicHooks(projectRoot), false, 'idempotent: second pass is a no-op');
  } finally {
    if (prevHome === undefined) { delete process.env.HOME; } else { process.env.HOME = prevHome; }
    if (prevUserProfile === undefined) { delete process.env.USERPROFILE; } else { process.env.USERPROFILE = prevUserProfile; }
  }
});

// ── Safety: malformed JSON is skipped untouched; missing files are a no-op. ──
ok('removeCozempicHooksFromFile: malformed JSON is skipped, missing file is a no-op', () => {
  const dir = tmp('cozempic-safe-');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ this is not: json, cozempic', 'utf8');
  assert.strictEqual(removeCozempicHooksFromFile(bad), false, 'malformed → no change');
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{ this is not: json, cozempic', 'malformed file left byte-identical');
  assert.strictEqual(removeCozempicHooksFromFile(path.join(dir, 'nope.json')), false, 'missing → no change');
});

console.log(`\ncozempicHooks smoke: ${pass} passed`);
