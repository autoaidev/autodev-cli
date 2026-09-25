// Offline smoke — the grok headless seed/tail DIR SELECTION (1.4.182 fix).
//
// THE BUG (Windows, grok-tui, after 1.4.181 forced grok to RESUME its session):
// the headless session-log tailer seeded + tailed the "newest-by-mtime" session
// dir (newestGrokSessionDir). But the session grok RESUMES (opts.sessionId) is
// NOT necessarily the newest dir on disk — a later stateless-fallback turn mints
// a fresh, NEWER dir. So the seed pointed at that newer UNRELATED dir; the pump
// then saw the resumed (older) dir as "not the seed dir", reset its byte offset
// to 0, and read the resumed session's file FROM THE START — surfacing a PRIOR
// turn's errored `turn_ended` as this turn's result → an instant retryable
// failure, looping forever at retry 1/10.
//
// THE FIX: when a concrete session id is known (resume OR new-persistent), seed +
// TAIL the FIXED dir grokSessionDirFor(path.resolve(cwd), id) — never
// newest-by-mtime — so a newer unrelated dir can never divert the tailer. This
// locks that invariant against the exact on-disk shape that broke it.
//
// Run: node test/grokSeedDir.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { newestGrokSessionDir, grokSessionDirFor } = await import('../out/providers/grok/sessions.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('grok seed/tail dir: fixed-dir selection beats newest-by-mtime');

/** Create a GROK_HOME session dir for cwd+id with a given events.jsonl mtime + body. */
function mkSession(grokHome, cwd, id, mtimeMs, body) {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(path.resolve(cwd)), id);
  fs.mkdirSync(dir, { recursive: true });
  const ev = path.join(dir, 'events.jsonl');
  fs.writeFileSync(ev, body ?? '{"type":"turn_started"}\n', 'utf8');
  const when = new Date(mtimeMs);
  fs.utimesSync(ev, when, when);
  return dir;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-seed-'));
const grokHome = path.join(tmpRoot, 'grokhome');
const cwd = path.join(tmpRoot, 'ws');
fs.mkdirSync(cwd, { recursive: true });
const prevGrokHome = process.env['GROK_HOME'];
process.env['GROK_HOME'] = grokHome;

try {
  const resumed = 'aaaaaaaa-1111-2222-3333-444444444444'; // the session we RESUME (older)
  const newer   = 'bbbbbbbb-5555-6666-7777-888888888888'; // an unrelated NEWER dir (stateless-fallback turn)

  // Session A (resumed): real events + a trailing ERRORED turn_ended (a prior failed turn).
  const aDir = mkSession(
    grokHome, cwd, resumed, Date.now() - 60_000,
    '{"type":"turn_started"}\n{"type":"first_token"}\n{"type":"turn_ended","outcome":"error"}\n',
  );
  // Session B: a NEWER unrelated dir (the exact condition that broke the seed).
  const bDir = mkSession(grokHome, cwd, newer, Date.now(), '{"type":"turn_started"}\n');

  ok('newestGrokSessionDir returns the NEWER unrelated dir B (the trap)', () => {
    assert.strictEqual(newestGrokSessionDir(cwd), bDir);
  });

  ok('grokSessionDirFor(cwd, resumedId) pins the RESUMED dir A, not B', () => {
    const fixed = grokSessionDirFor(path.resolve(cwd), resumed);
    assert.strictEqual(fixed, aDir);
    assert.notStrictEqual(fixed, newestGrokSessionDir(cwd)); // the tailer no longer follows "newest"
  });

  ok('encoding matches what grok writes on disk (dir exists at the fixed path)', () => {
    const fixed = grokSessionDirFor(path.resolve(cwd), resumed);
    assert.ok(fs.existsSync(path.join(fixed, 'events.jsonl')));
  });

  ok('new-persistent: a not-yet-created --session-id dir resolves under the enc-cwd', () => {
    // A brand-new session id has no dir yet → the fixed path still resolves (files
    // read from offset 0 once grok creates them); it is NOT the newest existing dir.
    const freshId = 'cccccccc-9999-0000-1111-222222222222';
    const fixed = grokSessionDirFor(path.resolve(cwd), freshId);
    assert.strictEqual(fixed, path.join(grokHome, 'sessions', encodeURIComponent(path.resolve(cwd)), freshId));
    assert.strictEqual(fs.existsSync(fixed), false);
  });

  console.log(`\ngrok seed/tail dir smoke: ${pass} checks passed`);
} finally {
  if (prevGrokHome === undefined) { delete process.env['GROK_HOME']; } else { process.env['GROK_HOME'] = prevGrokHome; }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
