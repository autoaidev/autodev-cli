// Offline smoke — the generated master `autodev` Agent Skill.
//
// Proves the agentskills.io invariants on media/skills/autodev/SKILL.md:
//   S1  it exists and its frontmatter `name` matches the directory (`autodev`).
//   S2  `description` is non-empty and ≤ 1024 chars.
//   S3  body < 16 KB.
//   S4  every `.autodev/profile/<file>` the routing index references maps to a
//       real PROFILE_SECTIONS file (and every section is indexed).
// Run: node test/autodevSkill.smoke.mjs   (after npm run build — the build runs
// the generator, so the file is present).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'media', 'skills', 'autodev', 'SKILL.md');

const { PROFILE_SECTIONS } = await import('../out/profileBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('autodevSkill smoke');

assert.ok(fs.existsSync(SKILL), 'media/skills/autodev/SKILL.md must exist (run npm run build)');
const raw = fs.readFileSync(SKILL, 'utf8');
const fmEnd = raw.indexOf('\n---', 3);
assert.ok(raw.startsWith('---\n') && fmEnd !== -1, 'SKILL.md must have YAML frontmatter');
const frontmatter = raw.slice(4, fmEnd);
const body = raw.slice(fmEnd + 4);

ok('S1: name matches the directory (autodev)', () => {
  const m = frontmatter.match(/^name:\s*(.+)$/m);
  assert.ok(m, 'frontmatter must have a name');
  assert.strictEqual(m[1].trim(), 'autodev', 'name must be "autodev"');
  assert.strictEqual(path.basename(path.dirname(SKILL)), 'autodev', 'dir must be autodev');
});

ok('S2: description non-empty and ≤ 1024 chars', () => {
  const m = frontmatter.match(/^description:\s*(.+)$/m);
  assert.ok(m, 'frontmatter must have a description');
  const desc = m[1].trim();
  assert.ok(desc.length > 0, 'description must be non-empty');
  assert.ok(desc.length <= 1024, `description must be ≤ 1024 chars (got ${desc.length})`);
});

ok('S3: body < 16 KB', () => {
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes < 16 * 1024, `body must be < 16384 bytes (got ${bytes})`);
});

ok('S4: every referenced .autodev/profile path maps to a real PROFILE_SECTIONS file', () => {
  const refs = [...body.matchAll(/\.autodev\/profile\/([\w.-]+\.md)/g)].map((x) => x[1]);
  assert.ok(refs.length > 0, 'body must reference .autodev/profile/*.md files');
  const known = new Set(PROFILE_SECTIONS.map((s) => s.file));
  for (const ref of refs) {
    assert.ok(known.has(ref), `referenced ${ref} is not a PROFILE_SECTIONS file`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'media', 'profile', ref)),
      `source pillar media/profile/${ref} must exist`,
    );
  }
  // …and every section is indexed (no pillar left unrouted).
  for (const s of PROFILE_SECTIONS) {
    assert.ok(refs.includes(s.file), `index is missing a row for ${s.file}`);
  }
});

console.log(`\nautodevSkill smoke: ${pass} passed`);
