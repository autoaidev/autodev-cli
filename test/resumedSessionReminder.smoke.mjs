// Offline smoke — cadence-gated intention/continuity reminders.
//
// The identity/intention reminders ride the PROFILE CADENCE (`includeProfile`):
// they fire on START, AFTER COMPACT / session reset (loop force-includes then),
// and every `profileEveryNTasks` turns (default 200) — NOT every turn. On a
// cadence turn the choice is:
//   - context REFRESHED (first turn / post-compact / reset / stateless) → point
//     the agent AT its anchors: firstTurnSystemReminder (read SOUL + PROGRAM).
//   - smoothly RESUMED (identity/protocol still in context) → the lightweight
//     TODO-continuity nudge (resumedSessionReminder): NO SOUL/identity re-read.
// A SOUL content change is event-driven and wins over either, any turn.
//
// The resumed nudge is ALSO gated on TODO.md actually changing since the last
// cadence turn (todoChangedSinceSeen): an intact resumed session where nothing
// moved (agent finished, just waiting) gets NO reminder — "do not send the
// system reminders if the files are not modified."
//
//   S1  resumedSessionReminder() is TODO-focused — no SOUL/identity re-read nag.
//   S2  first turn (includeProfile, !resumed) → firstTurn reminder, no TODO nudge.
//   S3  resumed INTACT cadence turn + TODO CHANGED (includeProfile, resumed,
//       !refreshed) → TODO nudge present, firstTurn absent — and in the messageFile.
//   S3b resumed INTACT cadence turn + TODO UNCHANGED → nudge ABSENT (no-noise gate).
//   S4  QUIET turn (includeProfile=false) → NEITHER reminder (no per-turn noise).
//   S5  context-REFRESHED cadence turn (includeProfile, resumed, refreshed) →
//       firstTurn reminder (read anchors after compact/reset), TODO nudge absent.
//   S6  SOUL-updated cadence turn → the "was UPDATED → re-read" reminder wins;
//       both cadence reminders are suppressed.
//   S7  stateless cadence turn (includeProfile, !resumed) → firstTurn reminder.
// Run: node test/resumedSessionReminder.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildMessage, resumedSessionReminder, todoChangedSinceSeen } = await import('../out/messageBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-resume-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [ ] do the thing\n');
  return d;
}

const task = { id: 'T1', text: 'do the thing', line: 1, attachments: [] };

// Reminder-identifying phrases (each unique to one reminder).
const RESUMED   = /CONTINUING your existing session/;   // resumedSessionReminder (TODO nudge)
const FIRSTTURN = /Before doing anything else/;          // firstTurnSystemReminder (read anchors)
const SOULUPD   = /was just UPDATED/;                    // soulUpdatedReminder

// Signatures: buildMessage(task, root, todoDir, includeProfile, resumedTurn, contextRefreshed)

console.log('resumedSessionReminder smoke');

// ── S1: the resumed nudge is TODO-focused, with no SOUL/identity re-read text. ──
ok('resumedSessionReminder() is TODO-focused — no SOUL re-read nag', () => {
  const r = resumedSessionReminder('/tmp/whatever');
  assert.match(r, /<system-reminder>/);
  assert.match(r, RESUMED, 'nudge must tell the agent it is continuing its session');
  assert.match(r, /TODO\.md/, 'nudge must carry the TODO-continuity instruction');
  assert.match(r, /\[~\]/, 'nudge must mention the [~] in-progress marker');
  assert.ok(!/SOUL\.md/.test(r), 'nudge must NOT reference SOUL.md (no identity re-read)');
  assert.ok(!/identity|persona|protocol/i.test(r), 'nudge must NOT nag about identity/protocol');
});

// ── S2: first turn → firstTurn reminder, NO TODO nudge. ──
ok('first turn: firstTurn reminder present, TODO nudge absent', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ false);
  assert.match(prompt, FIRSTTURN, 'turn 1 must carry the firstTurn PROGRAM/SOUL reminder');
  assert.ok(!RESUMED.test(prompt), 'turn 1 must NOT carry the resumed TODO nudge');
});

// ── S3: resumed intact cadence turn + TODO CHANGED → nudge present, firstTurn absent, in file. ──
ok('resumed intact cadence turn + TODO CHANGED: nudge present, firstTurn absent — and in the messageFile', () => {
  const d = tmpRoot();
  // Seed the .todo-seen marker (the first observation records silently and
  // returns false), then mutate TODO.md so this cadence turn sees a REAL change.
  assert.ok(!todoChangedSinceSeen(d, d), 'first observation records the hash silently, returns false');
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [~] do the thing\n- [ ] and another\n');
  const { prompt, messageFile } = buildMessage(
    task, d, d, /*includeProfile*/ true, /*resumedTurn*/ true, /*contextRefreshed*/ false,
  );
  assert.match(prompt, RESUMED, 'a CHANGED TODO on a resumed cadence turn must carry the nudge');
  assert.ok(!FIRSTTURN.test(prompt), 'resumed intact cadence turn must NOT carry the firstTurn reminder');
  // Dispatch truth: the model reads the messageFile, not the returned `prompt`.
  const msg = fs.readFileSync(messageFile, 'utf8');
  assert.match(msg, RESUMED, 'messageFile itself must carry the TODO nudge');
  assert.ok(
    msg.indexOf('<system-reminder>') < msg.indexOf('## Current task'),
    'the nudge must precede the task in the dispatched messageFile',
  );
});

// ── S3b: resumed intact cadence turn + TODO UNCHANGED → nudge ABSENT (no-noise gate). ──
ok('resumed intact cadence turn + TODO UNCHANGED: nudge absent — no reminder when files did not move', () => {
  const d = tmpRoot();
  // Seed the marker to the CURRENT TODO.md so nothing has changed since.
  assert.ok(!todoChangedSinceSeen(d, d), 'first observation returns false');
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ true, /*contextRefreshed*/ false);
  assert.ok(!RESUMED.test(prompt), 'an UNCHANGED TODO must suppress the continuity nudge');
  assert.ok(!FIRSTTURN.test(prompt), 'still no firstTurn reminder on an intact resumed turn');
});

// ── S4: QUIET (throttled) turn → neither reminder. ──
ok('quiet turn (includeProfile=false): no firstTurn and no TODO nudge', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ false, /*resumedTurn*/ true);
  assert.ok(!FIRSTTURN.test(prompt), 'a throttled turn must NOT carry the firstTurn reminder');
  assert.ok(!RESUMED.test(prompt), 'a throttled turn must NOT carry the TODO nudge');
});

// ── S5: context-refreshed cadence turn (compact/reset) → firstTurn, no nudge. ──
ok('context-refreshed cadence turn: firstTurn reminder, TODO nudge absent', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(
    task, d, d, /*includeProfile*/ true, /*resumedTurn*/ true, /*contextRefreshed*/ true,
  );
  assert.match(prompt, FIRSTTURN, 'post-compact/reset must re-point the agent AT its anchors');
  assert.ok(!RESUMED.test(prompt), 'a refreshed turn must NOT carry the "already loaded" nudge');
});

// ── S6: SOUL-updated cadence turn → SOUL re-read wins, both cadence reminders off. ──
ok('SOUL-updated cadence turn: re-read reminder wins, cadence reminders suppressed', () => {
  const d = tmpRoot();
  const soul = path.join(d, 'SOUL.md');
  fs.writeFileSync(soul, '# Soul\nName: Nova\n');
  fs.utimesSync(soul, new Date(1000_000), new Date(1000_000));
  buildMessage(task, d, d, false, false);          // observe once → marker recorded, silent
  fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nNow a designer.\n');
  fs.utimesSync(soul, new Date(2000_000), new Date(2000_000)); // office edit advances mtime
  const { prompt } = buildMessage(
    task, d, d, /*includeProfile*/ true, /*resumedTurn*/ true, /*contextRefreshed*/ false,
  );
  assert.match(prompt, SOULUPD, 'a real SOUL change must still trigger the re-read reminder');
  assert.ok(!RESUMED.test(prompt), 'the TODO nudge is suppressed when SOUL actually changed');
  assert.ok(!FIRSTTURN.test(prompt), 'the firstTurn reminder is suppressed when SOUL actually changed');
});

// ── S7: stateless cadence turn → firstTurn reminder. ──
ok('stateless cadence turn: firstTurn reminder present', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ false);
  assert.match(prompt, FIRSTTURN, 'a stateless cadence turn must carry the firstTurn reminder');
  assert.ok(!RESUMED.test(prompt), 'a stateless turn must NOT carry the resumed TODO nudge');
});

console.log(`\nresumedSessionReminder smoke: ${pass} passed`);
