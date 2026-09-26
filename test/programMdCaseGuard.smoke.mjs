// Offline smoke — PROGRAM.md is never deleted by the legacy-index cleanup, and is
// present + non-empty after every rebuild (the recurring "PROGRAM.md missing on
// Windows" bug).
//
// Root cause: injectAgentProfileRef migrates away from legacy index names
// (`.autodev/AGENT_PROFILE.md`, `.autodev/program.md`). On a case-INSENSITIVE FS
// (Windows) `.autodev/program.md` IS `.autodev/PROGRAM.md`, but fs.realpathSync
// echoes back the REQUESTED case, so the old realpath === compare missed the
// collision and rmSync('.autodev/program.md') deleted the live index.
//
//   C1  isCanonicalProfileCollision: `program.md` (any case) collides with the
//       canonical `.autodev/PROGRAM.md`; `AGENT_PROFILE.md` does NOT.
//   C2  post-rebuild INVARIANT: after rebuildProfile, PROGRAM.md exists + non-empty.
//   C3  a pre-existing PROGRAM.md survives rebuild present + non-empty (the cleanup
//       never nukes the live index).
// Run: node test/programMdCaseGuard.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { rebuildProfile, isCanonicalProfileCollision } = await import('../out/messageBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-pmcase-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [ ] do the thing\n');
  return d;
}

const prog = (d) => path.join(d, '.autodev', 'PROGRAM.md');

console.log('programMdCaseGuard smoke');

// ── C1: the case-insensitive collision decision (the guard that prevents the delete). ──
ok('isCanonicalProfileCollision: lowercase program.md collides with PROGRAM.md', () => {
  const d = tmpRoot();
  // The exact legacy candidate that case-collides on Windows.
  assert.strictEqual(isCanonicalProfileCollision(d, '.autodev/program.md'), true,
    'program.md must be treated as the SAME file as PROGRAM.md (never deleted)');
  // Uppercase / mixed case all resolve to the canonical file too.
  assert.strictEqual(isCanonicalProfileCollision(d, '.autodev/PROGRAM.md'), true);
  assert.strictEqual(isCanonicalProfileCollision(d, '.autodev/PrOgRaM.md'), true);
  // The other legacy name never collides — it is safe to remove.
  assert.strictEqual(isCanonicalProfileCollision(d, '.autodev/AGENT_PROFILE.md'), false,
    'AGENT_PROFILE.md must NOT be treated as the canonical index');
});

// ── C2: post-rebuild invariant — PROGRAM.md present + non-empty. ──
ok('rebuildProfile: PROGRAM.md exists and is non-empty afterward', () => {
  const d = tmpRoot();
  assert.ok(!fs.existsSync(prog(d)), 'precondition: no PROGRAM.md yet');
  rebuildProfile(d);
  assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must exist after rebuild');
  assert.ok(fs.statSync(prog(d)).size > 0, 'PROGRAM.md must be non-empty after rebuild');
});

// ── C3: a pre-existing PROGRAM.md is never nuked by the legacy cleanup. ──
ok('rebuildProfile: a pre-existing PROGRAM.md survives (never deleted by cleanup)', () => {
  const d = tmpRoot();
  fs.writeFileSync(prog(d), '# my index\nfile://./SOUL.md\n');
  // Also drop a genuinely-distinct legacy AGENT_PROFILE.md — that one IS allowed to
  // be migrated away, but PROGRAM.md must remain.
  fs.writeFileSync(path.join(d, '.autodev', 'AGENT_PROFILE.md'), '# legacy flat index\n');
  rebuildProfile(d);
  assert.ok(fs.existsSync(prog(d)), 'PROGRAM.md must still exist after rebuild');
  assert.ok(fs.statSync(prog(d)).size > 0, 'PROGRAM.md must still be non-empty after rebuild');
  // The genuinely-legacy flat index is migrated away (case-sensitive: distinct file).
  assert.ok(!fs.existsSync(path.join(d, '.autodev', 'AGENT_PROFILE.md')),
    'the legacy AGENT_PROFILE.md is migrated away');
});

console.log(`\nprogramMdCaseGuard smoke: ${pass} passed`);
