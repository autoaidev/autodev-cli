// Offline smoke — deterministic journal writer (autoresearch keep/discard rows).
//
// The model can't mis-format these rows because the EXTENSION writes them. This
// locks the table shape, file creation with a header, the JOURNAL.md index line,
// pipe/newline escaping, and the deterministic keep/discard tally used by the
// journalLearn pre-pass.
// Run: node test/journal.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { appendJournalRow, tallyJournal, journalDateStr, journalFilePath } =
  await import('../out/journal.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const root = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-journal-')));

console.log('journal smoke');

// ── 1. First append creates the dated file WITH a header + one row. ──
ok('first append creates the dated journal file with a header', () => {
  const d = root();
  const file = appendJournalRow(d, {
    task: 'add caching', hypothesis: 'cache halves latency', approach: 'LRU',
    outcome: 'verify green', status: 'keep', deltaComplexity: '+12/-3', notes: 'clean',
  });
  assert.strictEqual(file, journalFilePath(d), 'returns today’s dated path');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, new RegExp(`# Journal ${journalDateStr()}`), 'has a dated header');
  assert.match(body, /\| Task \| Hypothesis \| Approach \| Outcome \| Status \| ΔC \| Notes \|/, 'has the table header');
  assert.match(body, /\| add caching \| cache halves latency \| LRU \| verify green \| keep \| \+12\/-3 \| clean \|/, 'has the row');
});

// ── 2. Index line written to .autodev/JOURNAL.md, once. ──
ok('JOURNAL.md index gets exactly one line per dated file', () => {
  const d = root();
  appendJournalRow(d, { task: 't1', status: 'keep' });
  appendJournalRow(d, { task: 't2', status: 'discard' });
  const idx = fs.readFileSync(path.join(d, '.autodev', 'JOURNAL.md'), 'utf8');
  const dateStr = journalDateStr();
  const occurrences = idx.split(`journals/JOURNAL-${dateStr}.md`).length - 1;
  assert.strictEqual(occurrences, 1, 'index line must not be duplicated across appends');
  assert.match(idx, /# Journal Index/);
});

// ── 3. Pipes and newlines in cells are escaped — the table never breaks. ──
ok('pipes/newlines in a cell are neutralised', () => {
  const d = root();
  const file = appendJournalRow(d, {
    task: 'a | b\nsecond line', status: 'partial', notes: 'x | y',
  });
  const rowLine = fs.readFileSync(file, 'utf8').split('\n').find(l => l.includes('second line'));
  assert.ok(rowLine, 'row present');
  // The only UNescaped pipes are the 8 column delimiters (7 columns).
  const unescaped = (rowLine.match(/(?<!\\)\|/g) || []).length;
  assert.strictEqual(unescaped, 8, 'exactly 8 column delimiters, content pipes escaped');
  assert.ok(!rowLine.includes('\n') || rowLine.indexOf('\n') === rowLine.length - 0, 'no embedded newline splits the row');
});

// ── 4. Deterministic tally over the rows (journalLearn pre-pass). ──
ok('tallyJournal counts keep/discard/partial deterministically', () => {
  const d = root();
  appendJournalRow(d, { task: 'k1', status: 'keep' });
  appendJournalRow(d, { task: 'k2', status: 'keep' });
  appendJournalRow(d, { task: 'd1', status: 'discard' });
  appendJournalRow(d, { task: 'p1', status: 'partial' });
  const t = tallyJournal(d);
  assert.ok(t, 'tally returns a result when rows exist');
  assert.strictEqual(t.keep, 2);
  assert.strictEqual(t.discard, 1);
  assert.strictEqual(t.partial, 1);
  assert.strictEqual(t.total, 4);
  assert.match(t.digest, /2 keep, 1 discard, 1 partial/);
});

// ── 5. Empty journal ⇒ null tally ⇒ periodic prompt stays byte-identical. ──
ok('no journal rows ⇒ tally null (no digest prepended)', () => {
  const d = root();
  assert.strictEqual(tallyJournal(d), null, 'no journals dir ⇒ null');
  fs.mkdirSync(path.join(d, '.autodev', 'journals'), { recursive: true });
  assert.strictEqual(tallyJournal(d), null, 'empty journals dir ⇒ null');
});

console.log(`\n${pass} checks passed`);
