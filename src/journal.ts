import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Deterministic autoresearch-style journal writer.
//
// The model can't mis-format these rows because the EXTENSION writes them.
// Each kept/discarded task appends one machine-readable row to the current
// dated journal file and one index line to .autodev/JOURNAL.md. The journalLearn
// periodic action later tallies these rows deterministically (see periodicActions).
// ---------------------------------------------------------------------------

export type JournalStatus = 'keep' | 'discard' | 'partial';

export interface JournalRow {
  task: string;
  hypothesis?: string;
  approach?: string;
  outcome?: string;
  status: JournalStatus;
  /** ΔC — complexity delta, e.g. "+12/-3" or "-". */
  deltaComplexity?: string;
  notes?: string;
}

/** Local YYYY-MM-DD. */
export function journalDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Escape a value so it is safe to place inside a Markdown table cell. */
function cell(v: string | undefined): string {
  const s = (v ?? '').toString();
  return s
    .replace(/\r?\n/g, ' ')      // no newlines inside a table row
    .replace(/\|/g, '\\|')        // escape pipes so columns don't split
    .trim() || '-';
}

const TABLE_HEADER =
  '| Task | Hypothesis | Approach | Outcome | Status | ΔC | Notes |\n' +
  '| --- | --- | --- | --- | --- | --- | --- |\n';

/** Path of today's dated journal file. */
export function journalFilePath(root: string, date = new Date()): string {
  return path.join(root, '.autodev', 'journals', `JOURNAL-${journalDateStr(date)}.md`);
}

/**
 * Append one structured row to the current dated journal file (creating it with a
 * header if missing) plus one index line to .autodev/JOURNAL.md (deduped).
 * Pure file I/O — safe to call from the loop. Returns the dated file path.
 */
export function appendJournalRow(root: string, row: JournalRow, date = new Date()): string {
  const dir = path.join(root, '.autodev');
  const journalsDir = path.join(dir, 'journals');
  fs.mkdirSync(journalsDir, { recursive: true });

  const dateStr = journalDateStr(date);
  const file = journalFilePath(root, date);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Journal ${dateStr}\n\n${TABLE_HEADER}`, 'utf8');
  } else {
    // Guard against a file that exists but lost its header (manual edit).
    const existing = fs.readFileSync(file, 'utf8');
    if (!existing.includes('| Task |')) {
      fs.appendFileSync(file, `\n${TABLE_HEADER}`, 'utf8');
    }
  }

  const line =
    `| ${cell(row.task)} | ${cell(row.hypothesis)} | ${cell(row.approach)} | ` +
    `${cell(row.outcome)} | ${cell(row.status)} | ${cell(row.deltaComplexity)} | ${cell(row.notes)} |\n`;
  fs.appendFileSync(file, line, 'utf8');

  // Index line in .autodev/JOURNAL.md (one per dated file).
  const indexFile = path.join(dir, 'JOURNAL.md');
  const indexLine = `- [${dateStr}](journals/JOURNAL-${dateStr}.md)`;
  try {
    let index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
    if (!index) { index = '# Journal Index\n\n'; }
    if (!index.includes(indexLine)) {
      if (!index.endsWith('\n')) { index += '\n'; }
      index += indexLine + '\n';
      fs.writeFileSync(indexFile, index, 'utf8');
    }
  } catch { /* index is best-effort */ }

  return file;
}

/**
 * Deterministically tally keep/discard/partial rows across all dated journal
 * files. Used by the journalLearn periodic pre-pass so the model gets a compact
 * digest instead of re-scanning every file by hand. Returns null when there is
 * nothing to tally (keeps the periodic prompt byte-identical to before).
 */
export function tallyJournal(root: string): {
  keep: number; discard: number; partial: number; total: number;
  recentDiscards: string[]; digest: string;
} | null {
  const journalsDir = path.join(root, '.autodev', 'journals');
  if (!fs.existsSync(journalsDir)) { return null; }
  let keep = 0, discard = 0, partial = 0;
  const recentDiscards: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(journalsDir).filter(f => /^JOURNAL-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch { return null; }
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(journalsDir, f), 'utf8'); } catch { continue; }
    for (const ln of content.split(/\r?\n/)) {
      if (!ln.startsWith('|')) { continue; }
      const cols = ln.split('|').map(c => c.trim());
      // cols: ['', Task, Hypothesis, Approach, Outcome, Status, ΔC, Notes, '']
      if (cols.length < 7) { continue; }
      const status = (cols[5] || '').toLowerCase();
      const taskCol = cols[1] || '';
      if (status === 'keep') { keep++; }
      else if (status === 'discard') { discard++; recentDiscards.push(taskCol); }
      else if (status === 'partial') { partial++; }
    }
  }
  const total = keep + discard + partial;
  if (total === 0) { return null; }
  const tail = recentDiscards.slice(-5);
  const digest =
    `Journal tally (deterministic pre-pass): ${keep} keep, ${discard} discard, ${partial} partial ` +
    `across ${total} recorded attempts.` +
    (tail.length ? ` Recent discards: ${tail.map(t => t.slice(0, 60)).join('; ')}.` : '');
  return { keep, discard, partial, total, recentDiscards, digest };
}
