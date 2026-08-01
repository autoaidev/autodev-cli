// Offline smoke — loop agents default to resumeSession=true.
//
// A continuous loop wants ONE evolving provider session. resumeSession defaults
// to false (correct for one-shot `send`), but a loop running with resume off
// starts a fresh provider session every turn — for opencode that is a new row in
// the shared opencode.db each turn, which silently grew to 55k+ throwaway
// sessions (660 MB) on a real box. The loop-start fix flips resumeSession to true
// UNLESS the user set it explicitly (an explicit `false` must be honored so a
// deliberately-stateless loop still works).
//
// This locks down the discriminator that makes that safe — hasExplicitSetting —
// and replays the exact loop-start decision against temp workspaces:
//   1. key ABSENT      → hasExplicitSetting=false → flipped to true + persisted
//   2. explicit false  → hasExplicitSetting=true  → left false (honored)
//   3. explicit true   → hasExplicitSetting=true  → stays true
//
// Fully offline/deterministic. Run: node test/resumeSessionLoopDefault.smoke.mjs (after build).
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasExplicitSetting, settingsWritePath, loadSettingsForRoot } from '../out/core/settingsLoader.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok:', msg); passed++; };

/** Make a throwaway workspace whose .autodev/settings.json is `raw` (or none). */
function mkWorkspace(raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-resume-'));
  fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
  if (raw !== undefined) {
    fs.writeFileSync(path.join(root, '.autodev', 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');
  }
  return root;
}

/** The exact decision the loop makes at start (mirrors TaskLoop.init). Returns
 *  the effective resumeSession and whether it wrote the file. */
function applyLoopDefault(root) {
  let wrote = false;
  const settings = loadSettingsForRoot(root);
  if (!hasExplicitSetting(root, 'resumeSession')) {
    settings.resumeSession = true;
    const file = settingsWritePath(root);
    const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (onDisk.resumeSession !== true) {
      onDisk.resumeSession = true;
      fs.writeFileSync(file, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
      wrote = true;
    }
  }
  return { effective: settings.resumeSession, wrote };
}

// 1. Key absent → discriminator false, loop flips to true and persists.
{
  const root = mkWorkspace({ provider: 'opencode-cli' }); // no resumeSession key
  ok(hasExplicitSetting(root, 'resumeSession') === false, 'absent key → hasExplicitSetting=false');
  const r = applyLoopDefault(root);
  ok(r.effective === true, 'absent key → loop defaults resumeSession to true');
  ok(r.wrote === true, 'absent key → the true default is persisted to settings.json');
  const reread = JSON.parse(fs.readFileSync(settingsWritePath(root), 'utf8'));
  ok(reread.resumeSession === true, 'persisted value is readable on the next (per-turn) load');
  ok(reread.provider === 'opencode-cli', 'persist preserves the other settings keys');
  fs.rmSync(root, { recursive: true, force: true });
}

// 2. Explicit false → honored, never flipped, never written.
{
  const root = mkWorkspace({ provider: 'opencode-cli', resumeSession: false });
  ok(hasExplicitSetting(root, 'resumeSession') === true, 'explicit false → hasExplicitSetting=true');
  const r = applyLoopDefault(root);
  ok(r.effective === false, 'explicit false → loop honors it (stateless loop still works)');
  ok(r.wrote === false, 'explicit false → nothing rewritten');
  const reread = JSON.parse(fs.readFileSync(settingsWritePath(root), 'utf8'));
  ok(reread.resumeSession === false, 'explicit false stays false on disk');
  fs.rmSync(root, { recursive: true, force: true });
}

// 3. Explicit true → stays true.
{
  const root = mkWorkspace({ provider: 'claude-tui', resumeSession: true });
  ok(hasExplicitSetting(root, 'resumeSession') === true, 'explicit true → hasExplicitSetting=true');
  const r = applyLoopDefault(root);
  ok(r.effective === true, 'explicit true → stays true');
  fs.rmSync(root, { recursive: true, force: true });
}

// 4. Missing settings file → discriminator false (no throw).
{
  const root = mkWorkspace(undefined); // .autodev exists, no settings.json
  ok(hasExplicitSetting(root, 'resumeSession') === false, 'no settings file → hasExplicitSetting=false (no throw)');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nresumeSessionLoopDefault.smoke: ${passed} assertions passed`);
