// ---------------------------------------------------------------------------
// grok trusted_folders.toml — Windows-safe write + repair
// ---------------------------------------------------------------------------
// grok's per-folder trust store keys each trusted directory as a DOUBLE-QUOTED
// TOML table header:
//
//   [folders."C:\\Users\\me\\.autodev-app\\offices\\o\\a-1"]
//   trusted = true
//   decided_at = 1790173797
//
// TOML double-quoted strings interpret backslash escapes, so a raw Windows path
// (`C:\Users\me\…`) written verbatim into that key contains INVALID escapes
// (`\U`, `\u`, `\a`, `\.`, `\t`, `\d`, …) → the whole file is unparseable and
// grok reports "the trust store could not be read", falling back to the
// interactive trust prompt. Under grok-tui/tmux this ran only on Unix
// (forward-slash paths) so it wasn't seen in practice, but the write must be
// correct on every platform. This module owns the escaped write and repairs a
// store already corrupted by the old unescaped-backslash bug. Pure (only takes
// an explicit store path) so it is unit-testable standalone.

import * as fs from 'fs';
import * as path from 'path';

/**
 * TOML-escape a value destined for a DOUBLE-QUOTED key/string: backslash `\`→`\\`
 * and double-quote `"`→`\"`. Folder paths won't contain control characters, so
 * those two suffice. A Windows path `C:\Users\me` becomes `C:\\Users\\me`, which
 * grok's parser reads back as the exact original `C:\Users\me` → grok's folder
 * lookup MATCHES and it does not re-prompt.
 */
export function escapeTomlKey(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Matches a `[folders."<inner>"]` header, capturing the TOML-encoded inner key. */
const FOLDER_HEADER_RE = /^\s*\[folders\."(.*)"\]\s*$/;

/**
 * Recover the real OS path from a folders-key's inner (TOML-encoded) text,
 * tolerating BOTH the correct escaped form (`C:\\Users`) and the old bug's raw
 * form (`C:\Users`). `\\`→`\` and `\"`→`"` are decoded; any other `\X` (the
 * corrupt case) keeps the backslash as a literal separator. Both forms recover
 * to the same OS path.
 */
export function recoverPath(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1];
      if (n === '\\' || n === '"') {
        out += n;
        i++;
        continue;
      }
      out += c; // unknown escape → old bug's literal backslash
    } else {
      out += c;
    }
  }
  return out;
}

/** A store needs repair if any folders key is not already canonically escaped. */
export function storeNeedsRepair(text: string): boolean {
  if (!text) return false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(FOLDER_HEADER_RE);
    if (!m) continue;
    const inner = m[1];
    if (inner !== escapeTomlKey(recoverPath(inner))) return true;
  }
  return false;
}

/**
 * Rebuild a (possibly corrupt) store as valid TOML: every `[folders."…"]` key is
 * re-emitted properly escaped, preserving each entry's meta lines (trusted /
 * decided_at) and any preamble before the first header. Ensures `newAbs` is
 * present exactly once.
 */
export function rebuildStore(text: string, newAbs: string): string {
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  const entries: { p: string; meta: string[] }[] = [];
  let cur: { p: string; meta: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(FOLDER_HEADER_RE);
    if (m) {
      cur = { p: recoverPath(m[1]), meta: [] };
      entries.push(cur);
      continue;
    }
    if (cur) {
      if (line.trim() !== '') cur.meta.push(line);
    } else if (line.trim() !== '') {
      preamble.push(line);
    }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!entries.some((e) => e.p === newAbs)) {
    entries.push({ p: newAbs, meta: ['trusted = true', `decided_at = ${nowSec}`] });
  }
  const out: string[] = [];
  if (preamble.length) out.push(...preamble, '');
  for (const e of entries) {
    out.push(`[folders."${escapeTomlKey(e.p)}"]`);
    out.push(...(e.meta.length ? e.meta : ['trusted = true', `decided_at = ${nowSec}`]));
    out.push('');
  }
  return out.join('\n');
}

/**
 * Ensure `absRoot` is present and trusted in the trusted_folders.toml at `tf`.
 * Windows-safe (escaped key) and self-healing (repairs a store the old bug
 * corrupted with unescaped backslashes). Idempotent, best-effort (never throws).
 * Returns a short status string: 'present' | 'appended' | 'repaired' | 'error'.
 */
export function ensureGrokTrustAt(tf: string, absRoot: string): 'present' | 'appended' | 'repaired' | 'error' {
  try {
    const abs = path.resolve(absRoot);
    const escHeader = `[folders."${escapeTomlKey(abs)}"]`;
    let text = '';
    try { text = fs.readFileSync(tf, 'utf8'); } catch { /* no file yet */ }

    if (storeNeedsRepair(text)) {
      fs.mkdirSync(path.dirname(tf), { recursive: true });
      try { fs.writeFileSync(`${tf}.bak-${Date.now()}`, text, 'utf8'); } catch { /* best effort */ }
      let rebuilt = '';
      try { rebuilt = rebuildStore(text, abs); } catch { rebuilt = ''; }
      if (!rebuilt || !rebuilt.includes(escHeader)) {
        const nowSec = Math.floor(Date.now() / 1000);
        rebuilt = `${escHeader}\ntrusted = true\ndecided_at = ${nowSec}\n`;
      }
      fs.writeFileSync(tf, rebuilt, 'utf8');
      return 'repaired';
    }

    if (text.includes(escHeader)) return 'present';
    const nowSec = Math.floor(Date.now() / 1000);
    const entry = `${text.endsWith('\n') || text === '' ? '' : '\n'}\n${escHeader}\ntrusted = true\ndecided_at = ${nowSec}\n`;
    fs.mkdirSync(path.dirname(tf), { recursive: true });
    fs.appendFileSync(tf, entry, 'utf8');
    return 'appended';
  } catch {
    return 'error';
  }
}
