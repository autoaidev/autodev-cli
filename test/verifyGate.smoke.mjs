// Offline smoke — verify_and_keep decision logic on a real temp git repo.
//
// Mirrors the three branches the taskLoop gate takes, using the exact exported
// primitives it uses (runVerify) + git, so the decisions are proven end-to-end:
//   • GREEN  → the change is committed and advances the branch.
//   • RED    → git reset --hard restores the pre-task tree (the discard/revert).
//   • NO SPEC→ loadControlSpec returns null ⇒ isGateActive false ⇒ gate skipped
//              ⇒ today's unconditional-completion path is used unchanged.
// Run: node test/verifyGate.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const { runVerify, loadControlSpec, isGateActive } = await import('../out/core/controlSpec.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function gitRepo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-gate-')));
  const g = (c) => execSync(c, { cwd: d, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  g('git init -q');
  g('git config user.email t@t.t');
  g('git config user.name t');
  g('git config commit.gpgsign false');
  fs.writeFileSync(path.join(d, 'code.txt'), 'ok\n');
  g('git add -A');
  g('git commit -q -m initial');
  return { d, g, head: () => g('git rev-parse HEAD') };
}

console.log('verifyGate smoke');

// ── 1. GREEN → commit advances the branch. ──
ok('green verify: change is committed and HEAD advances', () => {
  const { d, g, head } = gitRepo();
  const pre = head();
  fs.writeFileSync(path.join(d, 'code.txt'), 'improved\n'); // the task's edit
  const vr = runVerify(['grep -q improved code.txt'], d, 60000);
  assert.strictEqual(vr.ok, true, 'verify passes on the good change');
  // keep: advance
  g('git add -A'); g('git commit -q -m "autodev: task"');
  assert.notStrictEqual(head(), pre, 'HEAD advanced (kept)');
  assert.strictEqual(fs.readFileSync(path.join(d, 'code.txt'), 'utf8'), 'improved\n');
});

// ── 2. RED → git reset --hard <pre> restores the pre-task tree (revert). ──
ok('red verify: reset --hard to pre-task commit reverts the change', () => {
  const { d, g, head } = gitRepo();
  const pre = head();
  fs.writeFileSync(path.join(d, 'code.txt'), 'BROKEN\n'); // bad edit
  fs.writeFileSync(path.join(d, 'oops.txt'), 'stray\n');   // stray untracked file
  const vr = runVerify(['grep -q improved code.txt'], d, 60000);
  assert.strictEqual(vr.ok, false, 'verify fails on the bad change');
  assert.ok(vr.code !== 0, 'non-zero exit surfaced');
  // exhaustion path: revert
  g(`git reset --hard ${pre}`);
  g('git clean -fdq');
  assert.strictEqual(head(), pre, 'HEAD back at pre-task commit');
  assert.strictEqual(fs.readFileSync(path.join(d, 'code.txt'), 'utf8'), 'ok\n', 'bad edit undone');
  assert.strictEqual(fs.existsSync(path.join(d, 'oops.txt')), false, 'stray file removed');
});

// ── 3. NO SPEC → gate skipped (today's path). ──
ok('no CONTROL.md ⇒ gate inactive ⇒ current unconditional path is used', () => {
  const { d } = gitRepo();
  const spec = loadControlSpec(d);
  assert.strictEqual(spec, null, 'no CONTROL.md ⇒ null spec');
  assert.strictEqual(isGateActive(spec), false, 'gate must be inactive → no verify, no revert, no journal');
});

// ── 4. runVerify: multi-command AND-gate + timeout flag. ──
ok('runVerify requires ALL commands green and reports timeouts', () => {
  const { d } = gitRepo();
  assert.strictEqual(runVerify(['true', 'true'], d, 60000).ok, true, 'all green ⇒ ok');
  assert.strictEqual(runVerify(['true', 'false'], d, 60000).ok, false, 'one red ⇒ not ok');
  const to = runVerify(['sleep 5'], d, 200); // 200ms timeout kills the 5s sleep
  assert.strictEqual(to.ok, false, 'timed-out command is not green');
});

console.log(`\n${pass} checks passed`);
