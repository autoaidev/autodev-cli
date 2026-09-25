// Offline smoke — rebuildProfile is robust: the CRITICAL writes (PROGRAM.md +
// SOUL.md) always land, even when the optional skill/MCP deployment fails, and
// cozempic hooks are reconciled (stripped) when cozempic is opt-out.
//
// BUG 1 — PROGRAM.md was not created on "Save & Rebuild" while SOUL.md was:
//   root cause was that applyAllSkills/applyMcpSkills ran BEFORE the PROGRAM.md
//   write, so an unguarded throw there (bundled-extension / Windows media layout,
//   corrupt .claude tree) skipped both PROGRAM.md (line 401) and rebuildProfile's
//   own ensureSoulSkeleton — while SOUL.md still appeared via the loop's separate
//   buildMessage path. Fix: write PROGRAM.md + SOUL.md FIRST, deploy skills LAST
//   (each isolated in try/catch), and always write a NON-EMPTY PROGRAM.md.
//
// BUG 2 — unchecking cozempic (cozempicAutoInit:false) must REMOVE already-wired
//   cozempic hooks from .claude/settings.local.json, not just stop new installs.
//
// Run: node test/rebuildProfileRobust.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// CommonJS build: messageBuilder calls (0, protocolSections_1.applyAllSkills)(root)
// — a LIVE property read — so replacing the export here forces a throw at the call
// site, proving rebuildProfile's own try/catch wrapper (not just the internal
// guards) keeps the critical writes safe.
const protocolSections = require('../out/protocolSections.js');
// sessionState is required with a LIVE property read at the call site
// ((0, sessionState_1.autodevDir)(root)); swapping the export here forces a throw
// AFTER the bulletproof bootstrap write but BEFORE the full profile write — proving
// the very-first-action write is what lands PROGRAM.md.
const sessionState = require('../out/sessionState.js');
const { rebuildProfile } = require('../out/messageBuilder.js');
const { removeCozempicHooks } = require('../out/cozempicHooks.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-rebuild-')));
}
const prog = (d) => path.join(d, '.autodev', 'PROGRAM.md');
const soul = (d) => path.join(d, 'SOUL.md');

console.log('rebuildProfileRobust smoke');

// ── BUG 1: fresh workspace → BOTH files, PROGRAM.md non-empty. ──
ok('rebuildProfile: fresh workspace creates non-empty PROGRAM.md AND SOUL.md', () => {
  const d = tmpRoot();
  rebuildProfile(d);
  assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist');
  assert.ok(fs.existsSync(soul(d)), 'SOUL.md must exist');
  const body = fs.readFileSync(prog(d), 'utf8');
  assert.ok(body.trim().length > 0, 'PROGRAM.md must be non-empty');
  assert.match(body, /PROGRAM\.md/, 'PROGRAM.md must carry the master-index header');
});

// ── BUG 1: injected failure in applyAllSkills → both files STILL created. ──
ok('rebuildProfile: applyAllSkills throws → PROGRAM.md + SOUL.md still created', () => {
  const d = tmpRoot();
  const orig = protocolSections.applyAllSkills;
  protocolSections.applyAllSkills = () => { throw new Error('boom: skills deploy failed (bundled/win layout)'); };
  try {
    assert.doesNotThrow(() => rebuildProfile(d), 'rebuildProfile must not propagate a skills failure');
    assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist despite applyAllSkills throwing');
    assert.ok(fs.readFileSync(prog(d), 'utf8').trim().length > 0, 'PROGRAM.md must be non-empty');
    assert.ok(fs.existsSync(soul(d)), 'SOUL.md must exist despite applyAllSkills throwing');
  } finally {
    protocolSections.applyAllSkills = orig;
  }
});

// ── BUG 1: injected failure in applyMcpSkills → both files STILL created. ──
ok('rebuildProfile: applyMcpSkills throws → PROGRAM.md + SOUL.md still created', () => {
  const d = tmpRoot();
  const orig = protocolSections.applyMcpSkills;
  protocolSections.applyMcpSkills = () => { throw new Error('boom: mcp skills deploy failed'); };
  try {
    assert.doesNotThrow(() => rebuildProfile(d), 'rebuildProfile must not propagate an mcp-skills failure');
    assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist despite applyMcpSkills throwing');
    assert.ok(fs.existsSync(soul(d)), 'SOUL.md must exist despite applyMcpSkills throwing');
  } finally {
    protocolSections.applyMcpSkills = orig;
  }
});

// ── BUG 1: reported real-world corrupt layout (a FILE where .claude dir is
//    expected) must not block the critical writes. ──
ok('rebuildProfile: corrupt .claude layout (file, not dir) still writes PROGRAM.md + SOUL.md', () => {
  const d = tmpRoot();
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude', 'skills'), 'not a dir'); // parent-is-a-file → mkdir would ENOTDIR
  assert.doesNotThrow(() => rebuildProfile(d));
  assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist under a corrupt .claude layout');
  assert.ok(fs.existsSync(soul(d)), 'SOUL.md must exist under a corrupt .claude layout');
});

// ── BUG 1 (bulletproof-first): the guaranteed minimal PROGRAM.md is written as the
//    VERY FIRST action, before autodevDir / settings / media assembly — so even if a
//    later step (a Windows office scratch-dir media/path issue) throws BEFORE the full
//    write, the agent still has a non-empty program index at the expected path. ──
ok('rebuildProfile: minimal PROGRAM.md always lands after a plain rebuild (non-empty)', () => {
  const d = tmpRoot();
  rebuildProfile(d);
  assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist at .autodev/PROGRAM.md');
  assert.ok(fs.readFileSync(prog(d), 'utf8').trim().length > 0, 'PROGRAM.md must be non-empty');
});

ok('rebuildProfile: a throw BEFORE the full write still leaves a non-empty PROGRAM.md (bootstrap-first)', () => {
  const d = tmpRoot();
  const orig = sessionState.autodevDir;
  // Throw at the FIRST post-bootstrap step. This propagates out of rebuildProfile
  // (autodevDir is intentionally unguarded), so the full profile write never runs —
  // only the bulletproof first-action write can have created the file.
  sessionState.autodevDir = () => { throw new Error('boom: office scratch-dir path issue (win)'); };
  try {
    assert.throws(() => rebuildProfile(d), /boom: office scratch-dir/,
      'the injected pre-write failure must propagate (proving nothing after the bootstrap ran)');
    assert.ok(fs.existsSync(prog(d)),
      'PROGRAM.md must STILL exist — written by the very-first bootstrap action');
    const body = fs.readFileSync(prog(d), 'utf8');
    assert.ok(body.trim().length > 0, 'the bootstrapped PROGRAM.md must be non-empty');
    assert.match(body, /PROGRAM\.md/, 'the bootstrap header must carry the program-index marker');
    assert.match(body, /SOUL\.md/, 'the bootstrap header must still point at the SOUL identity anchor');
  } finally {
    sessionState.autodevDir = orig;
  }
});

// ── BUG 2: removeCozempicHooks strips ONLY cozempic entries, preserves others. ──
function seedSettingsLocal(d, extra = {}) {
  const settings = {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [
          { type: 'command', command: "cozempic guard --daemon 2>/dev/null || true # cozempic-hook-schema=v5" },
        ] },
      ],
      PostToolUse: [
        { matcher: 'Task', hooks: [
          { type: 'command', command: "{ cozempic checkpoint 2>/dev/null; } || true # cozempic-hook-schema=v5" },
          { type: 'command', command: "echo keep-me" },
        ] },
      ],
      Stop: [
        { matcher: '', hooks: [
          { type: 'command', command: "my-own-tool --run" },
        ] },
      ],
    },
    ...extra,
  };
  const dir = path.join(d, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify(settings, null, 2));
  return path.join(dir, 'settings.local.json');
}

ok('removeCozempicHooks: strips exactly the cozempic entries, leaves others intact', () => {
  const d = tmpRoot();
  const p = seedSettingsLocal(d);
  const changed = removeCozempicHooks(d);
  assert.strictEqual(changed, true, 'must report a change when cozempic hooks were present');
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('cozempic'), 'no cozempic command may remain');
  // SessionStart was cozempic-only → the whole event key is dropped.
  assert.ok(!out.hooks.SessionStart, 'cozempic-only event key must be removed');
  // PostToolUse kept the non-cozempic leaf.
  assert.ok(out.hooks.PostToolUse, 'PostToolUse must survive (it had a non-cozempic hook)');
  assert.strictEqual(out.hooks.PostToolUse[0].hooks.length, 1, 'only the cozempic leaf is stripped');
  assert.strictEqual(out.hooks.PostToolUse[0].hooks[0].command, 'echo keep-me');
  // Stop (all non-cozempic) untouched, and unrelated settings preserved.
  assert.strictEqual(out.hooks.Stop[0].hooks[0].command, 'my-own-tool --run');
  assert.deepStrictEqual(out.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings preserved');
});

ok('removeCozempicHooks: does NOT false-positive strip a hook that merely mentions the word', () => {
  const d = tmpRoot();
  const dir = path.join(d, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const settings = { hooks: { Stop: [ { matcher: '', hooks: [
    { type: 'command', command: 'echo "this is not-cozempic related"' }, // word present, not an install
  ] } ] } };
  fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify(settings, null, 2));
  assert.strictEqual(removeCozempicHooks(d), false, 'a mere mention must not be treated as an install');
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'settings.local.json'), 'utf8'));
  assert.strictEqual(out.hooks.Stop[0].hooks[0].command, 'echo "this is not-cozempic related"');
});

ok('removeCozempicHooks: idempotent + safe when absent', () => {
  const d = tmpRoot();
  // No file at all.
  assert.strictEqual(removeCozempicHooks(d), false, 'no settings file → no change, no throw');
  // Seed, strip once, strip again → second call is a no-op.
  seedSettingsLocal(d);
  assert.strictEqual(removeCozempicHooks(d), true);
  assert.strictEqual(removeCozempicHooks(d), false, 'second strip must be a no-op');
});

// ── BUG 2: rebuildProfile reconciles cozempic when opt-out (default false). ──
ok('rebuildProfile: cozempicAutoInit:false removes wired cozempic hooks', () => {
  const d = tmpRoot();
  seedSettingsLocal(d);
  // settings default cozempicAutoInit=false (no .autodev/settings.json override).
  rebuildProfile(d);
  const out = fs.readFileSync(path.join(d, '.claude', 'settings.local.json'), 'utf8');
  assert.ok(!out.includes('cozempic'), 'unchecking + Save & Rebuild must remove cozempic hooks');
  assert.ok(out.includes('keep-me'), 'non-cozempic hooks must survive the reconcile');
  // Critical writes still happened.
  assert.ok(fs.existsSync(prog(d)) && fs.existsSync(soul(d)), 'PROGRAM.md + SOUL.md still written');
});

ok('rebuildProfile: cozempicAutoInit:true leaves wired cozempic hooks in place', () => {
  const d = tmpRoot();
  seedSettingsLocal(d);
  // Opt IN via .autodev/settings.json — rebuild must NOT strip the hooks.
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, '.autodev', 'settings.json'),
    JSON.stringify({ cozempicAutoInit: true }, null, 2));
  rebuildProfile(d);
  const out = fs.readFileSync(path.join(d, '.claude', 'settings.local.json'), 'utf8');
  assert.ok(out.includes('cozempic'), 'opt-in must preserve the installed cozempic hooks');
});

console.log(`\nrebuildProfileRobust smoke: ${pass} passed`);
