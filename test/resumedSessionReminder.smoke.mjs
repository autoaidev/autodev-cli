// Offline smoke — resume-aware reminder selection.
//
// Proves the per-resumed-turn override that stops a RESUMING agent (grok-cli/
// grok-tui, or any provider with resumeSession on) from redundantly re-reading its
// SOUL.md/PROGRAM.md identity+protocol every turn once the session already carries
// them. The override is additive and gated so it never fights the other reminders.
//
//   S1  resumedSessionReminder() returns the override text.
//   S2  FIRST turn (includeProfile=true): first-turn PROGRAM/SOUL reminder is
//       injected; the resumed override is NOT (identity genuinely loads on turn 1).
//   S3  RESUMED turn (includeProfile=false, resumedTurn=true): the resumed override
//       IS injected and the first-turn reminder is NOT — and it lands in the
//       messageFile the model actually reads (dispatch truth), not just `prompt`.
//   S4  STATELESS turn (includeProfile=false, resumedTurn=false): NEITHER the
//       first-turn reminder NOR the resumed override — the standing profile pillars
//       are left to drive identity, exactly as before.
//   S5  SOUL-UPDATED resumed turn: the SOUL "was UPDATED → re-read" reminder WINS;
//       the resumed override is suppressed so it never contradicts a real re-read.
//   S6  every-N profile re-send (includeProfile=true, resumedTurn=true): the
//       first-turn reminder is injected and the resumed override is suppressed.
// Run: node test/resumedSessionReminder.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildMessage, resumedSessionReminder } = await import('../out/messageBuilder.js');

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
const OVERRIDE  = /CONTINUING your existing session/;   // resumedSessionReminder
const FIRSTTURN = /Before doing anything else/;          // firstTurnSystemReminder
const SOULUPD   = /was just UPDATED/;                    // soulUpdatedReminder

console.log('resumedSessionReminder smoke');

// ── S1: the override builder returns the override text. ──
ok('resumedSessionReminder() returns the override text', () => {
  const r = resumedSessionReminder('/tmp/whatever');
  assert.match(r, /<system-reminder>/);
  assert.match(r, OVERRIDE, 'override must tell the agent it is continuing its session');
  assert.match(r, /Do NOT/, 'override must say not to re-read identity/protocol');
});

// ── S2: first turn → first-turn reminder, NO override. ──
ok('first turn: first-turn reminder present, resumed override absent', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ false);
  assert.match(prompt, FIRSTTURN, 'turn 1 must carry the first-turn PROGRAM/SOUL reminder');
  assert.ok(!OVERRIDE.test(prompt), 'turn 1 must NOT carry the resumed override');
});

// ── S3: resumed turn → override present, first-turn reminder absent, in messageFile. ──
ok('resumed turn: override present, first-turn absent — and in the messageFile', () => {
  const d = tmpRoot();
  const { prompt, messageFile } = buildMessage(task, d, d, /*includeProfile*/ false, /*resumedTurn*/ true);
  assert.match(prompt, OVERRIDE, 'resumed turn must carry the override');
  assert.ok(!FIRSTTURN.test(prompt), 'resumed turn must NOT carry the first-turn reminder');
  // Dispatch truth: the model reads the messageFile, not the returned `prompt`.
  const msg = fs.readFileSync(messageFile, 'utf8');
  assert.match(msg, OVERRIDE, 'messageFile itself must carry the override');
  // On a THROTTLED turn (includeProfile=false) the standing protocol block
  // (`NEXT TASK TO BEGIN`) is NOT sent; the per-turn `## Current task` block is.
  // The override must still precede the task content.
  assert.ok(!/NEXT TASK TO BEGIN/.test(msg), 'throttled turn must NOT carry the standing protocol prose');
  assert.ok(
    msg.indexOf('<system-reminder>') < msg.indexOf('## Current task'),
    'override must precede the task in the dispatched messageFile',
  );
});

// ── S4: stateless turn → neither reminder. ──
ok('stateless turn: no first-turn reminder and no resumed override', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ false, /*resumedTurn*/ false);
  assert.ok(!FIRSTTURN.test(prompt), 'stateless turn must NOT carry the first-turn reminder');
  assert.ok(!OVERRIDE.test(prompt), 'stateless turn must NOT carry the resumed override');
});

// ── S5: SOUL-updated resumed turn → SOUL re-read wins, override suppressed. ──
ok('SOUL-updated resumed turn: re-read reminder wins, override suppressed', () => {
  const d = tmpRoot();
  const soul = path.join(d, 'SOUL.md');
  fs.writeFileSync(soul, '# Soul\nName: Nova\n');
  fs.utimesSync(soul, new Date(1000_000), new Date(1000_000));
  buildMessage(task, d, d, false, false);          // observe once → marker recorded, silent
  fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nNow a designer.\n');
  fs.utimesSync(soul, new Date(2000_000), new Date(2000_000)); // office edit advances mtime
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ false, /*resumedTurn*/ true);
  assert.match(prompt, SOULUPD, 'a real SOUL change must still trigger the re-read reminder');
  assert.ok(!OVERRIDE.test(prompt), 'override must be suppressed when SOUL actually changed this turn');
});

// ── S6: every-N profile re-send (includeProfile=true on a resumed turn). ──
ok('every-N re-send: first-turn reminder injected, override suppressed', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, /*includeProfile*/ true, /*resumedTurn*/ true);
  assert.match(prompt, FIRSTTURN, 'periodic re-send must re-inject the PROGRAM/SOUL reminder');
  assert.ok(!OVERRIDE.test(prompt), 'override must not fire on a turn that re-sends the profile');
});

console.log(`\nresumedSessionReminder smoke: ${pass} passed`);
