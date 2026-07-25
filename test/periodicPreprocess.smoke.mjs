// Offline smoke — the deterministic pre-passes on the memory / journalLearn
// periodic actions (#4). Key guarantee: they are NO-OPS when there's nothing to
// do, so low-activity agents get a byte-identical prompt (no behavior change),
// and they only lift the mechanical file work off the model when it exists.
// Run: node test/periodicPreprocess.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { PERIODIC_ACTIONS, dedupeMemoryIndex } = await import('../out/periodicActions.js');
const { appendJournalRow } = await import('../out/journal.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const root = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-pp-')));
const byId = (id) => PERIODIC_ACTIONS.find(a => a.id === id);

console.log('periodic preprocess smoke');

// ── 1. journalLearn pre-pass: '' when no journal, digest when rows exist. ──
ok('journalLearn preprocess returns "" with no journal (prompt unchanged)', () => {
  const jl = byId('journalLearn');
  assert.ok(typeof jl.preprocess === 'function', 'journalLearn has a preprocess');
  const d = root();
  assert.strictEqual(jl.preprocess(d), '', 'empty digest ⇒ prompt byte-identical to before');
});
ok('journalLearn preprocess returns a tally digest once rows exist', () => {
  const jl = byId('journalLearn');
  const d = root();
  appendJournalRow(d, { task: 'x', status: 'keep' });
  appendJournalRow(d, { task: 'y', status: 'discard' });
  assert.match(jl.preprocess(d), /1 keep, 1 discard/);
});

// ── 2. memory pre-pass: '' when index clean, note when it dedupes. ──
ok('memory preprocess is a no-op on a clean/absent index', () => {
  const mem = byId('memory');
  assert.ok(typeof mem.preprocess === 'function', 'memory has a preprocess');
  const d = root();
  assert.strictEqual(mem.preprocess(d), '', 'no MEMORY.md ⇒ no change');
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, '.autodev', 'MEMORY.md'), '# Memory Index\n\n- [a](memories/a.md)\n- [b](memories/b.md)\n');
  assert.strictEqual(mem.preprocess(d), '', 'unique entries ⇒ no change');
});
ok('memory preprocess dedupes duplicate index lines', () => {
  const d = root();
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, '.autodev', 'MEMORY.md'),
    '# Memory Index\n\n- [a](memories/a.md)\n- [a again](memories/a.md)\n- [b](memories/b.md)\n');
  const note = dedupeMemoryIndex(d);
  assert.match(note, /removed 1 duplicate/);
  const body = fs.readFileSync(path.join(d, '.autodev', 'MEMORY.md'), 'utf8');
  assert.strictEqual((body.match(/memories\/a\.md/g) || []).length, 1, 'duplicate target removed');
  assert.match(body, /memories\/b\.md/, 'unique entry preserved');
});

// ── 3. The two toolified actions kept their model-facing prompt (distillation). ──
ok('memory/journalLearn still carry their model distillation prompt', () => {
  assert.match(byId('memory').prompt, /consolidate what you have learned/i);
  assert.match(byId('journalLearn').prompt, /journal review/i);
});

console.log(`\n${pass} checks passed`);
