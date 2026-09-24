// grok trust-store smoke — the Windows unescaped-backslash TOML bug.
//
// grok keys each trusted folder as a DOUBLE-QUOTED TOML header
// `[folders."<path>"]`. The old code wrote the raw OS path verbatim, so a Windows
// path (`C:\Users\…`) landed in the key with LONE backslashes → invalid TOML
// escapes (\U,\u,\a,\.,\t,\d) → grok "trust store could not be read" → falls back
// to the interactive trust prompt so `grok --always-approve` can't launch.
//
// Locks: (1) a fresh store gets an ESCAPED key that round-trips to the exact
// Windows path, (2) a store already corrupted by the old bug is REPAIRED (all
// entries preserved, escaped, no lone backslash left), (3) idempotent.
// Run: node test/grokTrust.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  escapeTomlKey,
  recoverPath,
  storeNeedsRepair,
  ensureGrokTrustAt
} from '../out/providers/grok/trustStore.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  \u2713', name); pass++; };

// A tiny TOML folders-key parser: split the file into [folders."<inner>"] blocks
// and decode each inner exactly as a TOML double-quoted string would. Throws on
// an INVALID escape (what grok's real parser does), so a corrupt store fails.
function parseFolderKeys(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[folders\."(.*)"\]\s*$/);
    if (!m) continue;
    const inner = m[1];
    let decoded = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\') {
        const n = inner[i + 1];
        if (n === '\\') { decoded += '\\'; i++; }
        else if (n === '"') { decoded += '"'; i++; }
        else { throw new Error('invalid TOML escape \\' + n); }
      } else {
        decoded += c;
      }
    }
    keys.push(decoded);
  }
  return keys;
}

const WIN = 'C:\\Users\\user\\.autodev-app\\offices\\o\\a-1';
// ensureGrokTrustAt calls path.resolve() (correct: on Windows it keeps `C:\…`
// absolute). On the Linux CI host resolve() prepends cwd to this Windows string,
// so the NEW entry's stored path is resolve(WIN). What we're proving is the
// ESCAPING + REPAIR, which is platform-independent — assert the new entry against
// the same resolve the code uses. On the real Windows target EXP === WIN.
const EXP = path.resolve(WIN);

// The user's ACTUAL corrupt store (three offices, unescaped backslashes).
const CORRUPT = [
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\test-fakturi\\accountant-a22ef"]',
  'trusted = true',
  'decided_at = 1790173797',
  '',
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\society-analyst-8d03d"]',
  'trusted = true',
  'decided_at = 1790246856',
  '',
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\data-engineer-42e57"]',
  'trusted = true',
  'decided_at = 1790246886',
  ''
].join('\n');

console.log('grok trust-store smoke');

ok('escapeTomlKey doubles backslashes and escapes quotes', () => {
  assert.equal(escapeTomlKey(WIN), 'C:\\\\Users\\\\user\\\\.autodev-app\\\\offices\\\\o\\\\a-1');
  assert.equal(escapeTomlKey('a"b'), 'a\\"b');
});

ok('recoverPath round-trips both escaped and raw forms to the same OS path', () => {
  assert.equal(recoverPath(escapeTomlKey(WIN)), WIN);       // escaped -> path
  assert.equal(recoverPath(WIN), WIN);                       // raw (bug) -> same path
});

ok('the OLD raw fixture proves the bug: grok-style parser rejects it', () => {
  assert.throws(() => parseFolderKeys(CORRUPT), /invalid TOML escape/);
  assert.equal(storeNeedsRepair(CORRUPT), true);
});

ok('fresh store: key is escaped, valid TOML, round-trips to the exact Windows path', () => {
  const tf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-trust-')), 'trusted_folders.toml');
  const r = ensureGrokTrustAt(tf, WIN);
  assert.equal(r, 'appended');
  const text = fs.readFileSync(tf, 'utf8');
  // the Windows tail is escaped (doubled backslashes) as a substring of the key
  assert.ok(text.includes('C:\\\\Users\\\\user\\\\.autodev-app\\\\offices\\\\o\\\\a-1'));
  // valid TOML (grok-style parser does not throw) AND round-trips to the exact path
  const keys = parseFolderKeys(text);
  assert.deepEqual(keys, [EXP]);
  assert.equal(storeNeedsRepair(text), false);
});

ok('corrupt store is REPAIRED: valid TOML, all 3 originals preserved + new added once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-trust-'));
  const tf = path.join(dir, 'trusted_folders.toml');
  fs.writeFileSync(tf, CORRUPT, 'utf8');
  const r = ensureGrokTrustAt(tf, WIN);
  assert.equal(r, 'repaired');
  const text = fs.readFileSync(tf, 'utf8');
  const keys = parseFolderKeys(text); // must NOT throw now
  // all three original folders survive
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\test-fakturi\\accountant-a22ef'));
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\society-analyst-8d03d'));
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\data-engineer-42e57'));
  // new one added
  assert.ok(keys.includes(EXP));
  assert.equal(keys.length, 4);
  // decided_at values preserved
  assert.ok(text.includes('decided_at = 1790173797'));
  assert.ok(text.includes('decided_at = 1790246856'));
  assert.ok(text.includes('decided_at = 1790246886'));
  // no unescaped backslash remains in any folders key
  assert.equal(storeNeedsRepair(text), false);
  // a backup of the broken original exists
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('trusted_folders.toml.bak-')));
});

ok('idempotent: repair then re-run does not duplicate or re-corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-trust-'));
  const tf = path.join(dir, 'trusted_folders.toml');
  fs.writeFileSync(tf, CORRUPT, 'utf8');
  ensureGrokTrustAt(tf, WIN);                 // repaired
  const r2 = ensureGrokTrustAt(tf, WIN);      // second call
  assert.equal(r2, 'present');
  const keys = parseFolderKeys(fs.readFileSync(tf, 'utf8'));
  assert.equal(keys.filter((k) => k === EXP).length, 1);
  assert.equal(keys.length, 4);
});

console.log(`\ngrok trust-store smoke: ${pass} assertions passed`);
