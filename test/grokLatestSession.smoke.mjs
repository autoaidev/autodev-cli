// Offline smoke — grok session disk-detection + the provider resolveSession fallback.
//
// THE BUG (fixed here): grok agents started a BRAND NEW session every loop turn
// because grok-cli never resumed at all, and grok-tui had no disk-detection
// fallback when .autodev/session-state.json was missing/stale — so context was
// lost turn-over-turn. The fix adds getGrokLatestSessionId(root) (newest grok
// session dir on disk → its id) and wires BOTH grok-cli and grok-tui to resume
// via getSessionId() ?? getGrokLatestSessionId().
//
// This locks the pure pieces (no process spawn):
//   getGrokLatestSessionId       — newest session dir's id for a cwd (by events.jsonl mtime)
//   GrokCliProvider.resolveSession / GrokTuiProvider.resolveSession
//                                — stored id preferred; disk-detection as fallback
//
// Run: node test/grokLatestSession.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { getGrokLatestSessionId, newestGrokSessionDir } = await import('../out/providers/grok/sessions.js');
const { GrokCliProvider, GrokTuiProvider } = await import('../out/providers/grok/ProviderManager.js');
const { saveSessionId } = await import('../out/sessionState.js');

let pass = 0;
const ok = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };

console.log('grok latest-session: getGrokLatestSessionId + resolveSession fallback');

/** Create a fake GROK_HOME session dir for `cwd`+`id` with a given mtime (ms). */
function mkSession(grokHome, cwd, id, mtimeMs) {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(path.resolve(cwd)), id);
  fs.mkdirSync(dir, { recursive: true });
  const ev = path.join(dir, 'events.jsonl');
  fs.writeFileSync(ev, '{"type":"turn_started"}\n', 'utf8');
  const when = new Date(mtimeMs);
  fs.utimesSync(ev, when, when);
  return dir;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-latest-'));
const grokHome = path.join(tmpRoot, 'grokhome');
const cwd = path.join(tmpRoot, 'ws');
fs.mkdirSync(cwd, { recursive: true });
const prevGrokHome = process.env['GROK_HOME'];
process.env['GROK_HOME'] = grokHome;

try {
  // No sessions yet → undefined (a fresh cwd resolves as "new").
  await ok('no grok sessions on disk → getGrokLatestSessionId undefined', () => {
    assert.strictEqual(getGrokLatestSessionId(cwd), undefined);
  });

  // Two sessions; the NEWER (by events.jsonl mtime) is the one to resume.
  const older = 'aaaaaaaa-1111-2222-3333-444444444444';
  const newer = 'bbbbbbbb-5555-6666-7777-888888888888';
  mkSession(grokHome, cwd, older, Date.now() - 60_000);
  mkSession(grokHome, cwd, newer, Date.now());

  await ok('getGrokLatestSessionId returns the NEWEST session dir id', () => {
    assert.strictEqual(getGrokLatestSessionId(cwd), newer);
    assert.strictEqual(path.basename(newestGrokSessionDir(path.resolve(cwd))), newer);
  });

  // resolveSession with NO session-state.json → disk-detection fallback finds `newer`.
  await ok('grok-cli resolveSession falls back to disk id when session-state.json absent', async () => {
    const sid = await new GrokCliProvider().resolveSession(cwd, () => {});
    assert.strictEqual(sid, newer);
  });
  await ok('grok-tui resolveSession falls back to disk id when session-state.json absent', async () => {
    const sid = await new GrokTuiProvider().resolveSession(cwd, () => {});
    assert.strictEqual(sid, newer);
  });

  // A stored id in session-state.json is PREFERRED over disk-detection.
  saveSessionId(cwd, 'grok-cli', 'stored-cli-id');
  saveSessionId(cwd, 'grok-tui', 'stored-tui-id');
  await ok('grok-cli resolveSession prefers the stored session id', async () => {
    const sid = await new GrokCliProvider().resolveSession(cwd, () => {});
    assert.strictEqual(sid, 'stored-cli-id');
  });
  await ok('grok-tui resolveSession prefers the stored session id', async () => {
    const sid = await new GrokTuiProvider().resolveSession(cwd, () => {});
    assert.strictEqual(sid, 'stored-tui-id');
  });

  // Deleting session-state.json proves the disk-detection fallback re-finds `newer`.
  fs.rmSync(path.join(cwd, '.autodev', 'session-state.json'), { force: true });
  await ok('after deleting session-state.json, grok-cli re-detects the disk id', async () => {
    const sid = await new GrokCliProvider().resolveSession(cwd, () => {});
    assert.strictEqual(sid, newer);
  });
} finally {
  if (prevGrokHome === undefined) { delete process.env['GROK_HOME']; }
  else { process.env['GROK_HOME'] = prevGrokHome; }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\ngrok latest-session smoke: ${pass} checks passed`);
