// Offline smoke — profile/pillars cadence (profileEveryNTasks, default 50).
//
// Proves the throttle that stops the heavy AutoDev profile/pillars from being
// re-dumped into a persistent agent's context every turn, while keeping full
// per-turn delivery for stateless agents and surviving a process restart via a
// persisted counter.
//
//   S1  DEFAULT is 50 (settings default + module constant).
//   S2  PERSISTENT session: turn 1 includes; turns 2..50 exclude; turn 51 re-includes.
//   S3  STATELESS session: every turn includes (never throttled).
//   S4  Persisted counter SURVIVES a simulated process restart — a resumed
//       persistent session does NOT re-dump the profile on restart.
//   S5  forceInclude (fresh session after a reset) re-includes even mid-cadence.
//   S6  interval 0 disables the periodic refresh (persistent: only the first turn).
//   S7  load/save round-trip + NEVER sentinel for an absent file.
// Run: node test/profileCadence.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  decideProfileInclusion, loadProfileTurns, saveProfileTurns, resetProfileTurns,
  DEFAULT_PROFILE_EVERY_N, PROFILE_NEVER, PROFILE_TURNS_FILE,
} = await import('../out/core/profileCadence.js');
const { loadSettingsForRoot } = await import('../out/core/settingsLoader.js');
const { buildMessage, buildTaskProtocolBlock } = await import('../out/messageBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-profcad-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  return d;
}

console.log('profileCadence smoke');

// ── S1: default is 50. ──
ok('default cadence is 50', () => {
  assert.strictEqual(DEFAULT_PROFILE_EVERY_N, 50, 'module default must be 50');
  // settingsLoader default (the user-facing setting) must also be 50.
  const d = tmpRoot();
  const s = loadSettingsForRoot(d);
  assert.strictEqual(s.profileEveryNTasks, 50, 'settings default profileEveryNTasks must be 50');
});

// ── S2: persistent session — turn 1 in, 2..50 out, 51 in. ──
ok('persistent: turn 1 includes, 2..50 exclude, 51 re-includes', () => {
  const interval = 50;
  let counter = PROFILE_NEVER; // never delivered
  const includedTurns = [];
  for (let turn = 1; turn <= 51; turn++) {
    const r = decideProfileInclusion({
      turnsSinceProfile: counter, profileInterval: interval, contextPersists: true,
    });
    if (r.includeProfile) { includedTurns.push(turn); }
    counter = r.turnsSinceProfile;
  }
  assert.deepStrictEqual(includedTurns, [1, 51],
    `persistent session must include only on turn 1 and 51, got ${includedTurns}`);
});

// ── S3: stateless session — every turn includes. ──
ok('stateless: every turn includes (never throttled)', () => {
  let counter = PROFILE_NEVER;
  let allIncluded = true;
  for (let turn = 1; turn <= 10; turn++) {
    const r = decideProfileInclusion({
      turnsSinceProfile: counter, profileInterval: 50, contextPersists: false,
    });
    if (!r.includeProfile) { allIncluded = false; }
    counter = r.turnsSinceProfile;
  }
  assert.ok(allIncluded, 'a stateless turn must ALWAYS include the profile');
});

// ── S4: persisted counter survives a simulated process restart. ──
ok('persisted counter survives a process restart (no re-dump on resume)', () => {
  const d = tmpRoot();
  // Simulate the loop running 10 persistent turns, persisting each turn.
  let counter = loadProfileTurns(d); // absent → NEVER
  assert.strictEqual(counter, PROFILE_NEVER, 'absent file reads as NEVER');
  const firstTurnIncludes = [];
  for (let turn = 1; turn <= 10; turn++) {
    counter = loadProfileTurns(d);
    const r = decideProfileInclusion({ turnsSinceProfile: counter, profileInterval: 50, contextPersists: true });
    if (r.includeProfile) { firstTurnIncludes.push(turn); }
    saveProfileTurns(d, r.turnsSinceProfile);
  }
  assert.deepStrictEqual(firstTurnIncludes, [1], 'only turn 1 includes across the first 10 turns');
  // NOW simulate a process RESTART: a brand-new loop reads the persisted counter.
  // Because the session resumed (context intact), it must NOT re-dump the profile.
  const afterRestart = decideProfileInclusion({
    turnsSinceProfile: loadProfileTurns(d), profileInterval: 50, contextPersists: true,
  });
  assert.strictEqual(afterRestart.includeProfile, false,
    'a restart that resumes a persistent session must NOT re-dump the profile');
});

// ── S5: forceInclude re-includes mid-cadence (fresh session after reset). ──
ok('forceInclude re-includes even mid-cadence', () => {
  const r = decideProfileInclusion({
    turnsSinceProfile: 7, profileInterval: 50, contextPersists: true, forceInclude: true,
  });
  assert.strictEqual(r.includeProfile, true, 'a freshly-reset session must re-inject the profile');
  assert.strictEqual(r.turnsSinceProfile, 1, 'counter restarts at 1 after a forced inclusion');
});

// ── S6: interval 0 disables the periodic refresh on a persistent session. ──
ok('interval 0 → persistent session includes only the first turn', () => {
  let counter = PROFILE_NEVER;
  const included = [];
  for (let turn = 1; turn <= 200; turn++) {
    const r = decideProfileInclusion({ turnsSinceProfile: counter, profileInterval: 0, contextPersists: true });
    if (r.includeProfile) { included.push(turn); }
    counter = r.turnsSinceProfile;
  }
  assert.deepStrictEqual(included, [1], 'interval 0 must include only on the first persistent turn');
});

// ── S7: persistence round-trip + reset sentinel. ──
ok('load/save round-trip and reset sentinel', () => {
  const d = tmpRoot();
  saveProfileTurns(d, 12);
  assert.strictEqual(loadProfileTurns(d), 12, 'saved counter round-trips');
  assert.ok(fs.existsSync(path.join(d, PROFILE_TURNS_FILE)), 'persistence file is written under .autodev/');
  resetProfileTurns(d);
  assert.strictEqual(loadProfileTurns(d), PROFILE_NEVER, 'reset writes the NEVER sentinel');
});

// ── S8: the GATE in buildMessage — the standing protocol block rides the
// includeProfile cadence; the per-turn Current-task block (incl. the marking
// line) ships on EVERY turn. This is the end-to-end payoff of the cadence:
// stop re-sending the `NEXT TASK TO BEGIN` boilerplate every turn. ──
ok('throttled turn: Current-task + marking line present, NEXT-TASK prose absent', () => {
  const d = tmpRoot();
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [ ] do the thing\n');
  const task = { id: 'T1', text: 'do the thing', line: 1, attachments: [] };
  const { messageFile } = buildMessage(task, d, d, /*includeProfile*/ false, /*resumedTurn*/ true);
  const msg = fs.readFileSync(messageFile, 'utf8');
  // Per-turn specifics are ALWAYS present…
  assert.match(msg, /## Current task/, 'throttled turn must still carry the Current-task block');
  assert.match(msg, /Mark this task `\[~\]` before starting and `\[x\]` only once a real deliverable exists on disk\./,
    'the always-present marking line must survive on a throttled turn (TODO-marking contract)');
  // …but the STANDING protocol prose is NOT re-sent.
  assert.ok(!/NEXT TASK TO BEGIN/.test(msg), 'throttled turn must NOT re-send the NEXT-TASK protocol prose');
  assert.ok(!/### Steps required/.test(msg), 'throttled turn must NOT re-send the generic Steps-required prose');
});

ok('included turn: BOTH the standing protocol and the Current-task block present', () => {
  const d = tmpRoot();
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [ ] do the thing\n');
  const task = { id: 'T1', text: 'do the thing', line: 1, attachments: [] };
  const { messageFile } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ false);
  const msg = fs.readFileSync(messageFile, 'utf8');
  assert.match(msg, /NEXT TASK TO BEGIN/, 'an includeProfile turn must carry the standing protocol prose');
  assert.match(msg, /### Steps required/, 'an includeProfile turn must carry the Steps-required prose');
  assert.match(msg, /## Current task/, 'an includeProfile turn must also carry the Current-task block');
  assert.match(msg, /Mark this task `\[~\]` before starting/, 'the marking line is present on an included turn too');
  // The protocol goes FIRST, then the current task (historical framing order).
  assert.ok(msg.indexOf('NEXT TASK TO BEGIN') < msg.indexOf('## Current task'),
    'the standing protocol block must precede the Current-task block');
});

// ── S9: the Claude system-prompt text comes from the SAME source as the inline
// protocol block, so the native system prompt and the every-50 inline refresh
// can never diverge. ──
ok('buildTaskProtocolBlock is the single standing-protocol source (system prompt == inline)', () => {
  const block = buildTaskProtocolBlock();
  assert.match(block, /NEXT TASK TO BEGIN/, 'the standing block carries the NEXT-TASK framing');
  assert.match(block, /### Steps required/, 'the standing block carries the Steps-required prose');
  assert.match(block, /PRODUCED DELIVERABLE, never with an intention/, 'the standing block carries the deliverable hardening');
  assert.match(block, /@file:\/\/\.\/\.autodev\/PROGRAM\.md/, 'the standing block carries the PROGRAM.md pointer');
  // Task-independent: no per-task interpolation leaks into the standing text.
  assert.ok(!/## Current task/.test(block), 'the standing block must NOT contain per-turn task specifics');
});

console.log(`\nprofileCadence smoke: ${pass} passed`);
