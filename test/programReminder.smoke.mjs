// Offline smoke — first-turn program.md reminder injection + SOUL.md persistence.
//
// Proves the two focused changes:
//   R1a  program.md EXISTS  → buildMessage's first turn (includeProfile=true)
//        prepends a <system-reminder> that names BOTH program.md (protocol index)
//        and SOUL.md (identity anchor).
//   R1b  program.md ABSENT  → firstTurnSystemReminder() returns '' (no broken
//        pointer / no reference).
//   R1c  Subsequent turn (includeProfile=false) → no reminder injected even
//        though buildMessage re-writes program.md.
//   R2   rebuildProfile() regenerates program.md but NEVER touches a pre-existing
//        SOUL.md (identity/persona is safe across rebuilds).
// Run: node test/programReminder.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildMessage, firstTurnSystemReminder, rebuildProfile } =
  await import('../out/messageBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function tmpRoot() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-prog-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(d, 'TODO.md'), '- [ ] do the thing\n');
  return d;
}

const task = { id: 'T1', text: 'do the thing', line: 1, attachments: [] };

console.log('programReminder smoke');

// ── R1b: existence gate — absent program.md ⇒ empty reminder. ──
ok('firstTurnSystemReminder: absent program.md → no reminder', () => {
  const d = tmpRoot();
  // No .autodev/PROGRAM.md present.
  assert.strictEqual(firstTurnSystemReminder(d), '', 'expected empty string when program.md missing');
});

// ── R1a: existence gate — present program.md ⇒ reminder names both files. ──
ok('firstTurnSystemReminder: present program.md → names program.md + SOUL.md', () => {
  const d = tmpRoot();
  fs.writeFileSync(path.join(d, '.autodev', 'PROGRAM.md'), '# index\n');
  const r = firstTurnSystemReminder(d);
  assert.match(r, /<system-reminder>/);
  assert.match(r, /PROGRAM\.md/, 'reminder must reference PROGRAM.md');
  assert.match(r, /SOUL\.md/, 'reminder must reference SOUL.md');
});

// ── R1a end-to-end: first turn (includeProfile=true) prepends the reminder. ──
ok('buildMessage: first turn injects the reminder ahead of the task', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, true);
  assert.ok(prompt.includes('<system-reminder>'), 'first-turn prompt should contain the reminder');
  assert.match(prompt, /PROGRAM\.md/);
  assert.match(prompt, /SOUL\.md/);
  // buildMessage writes program.md itself, so the gate is satisfied.
  assert.ok(fs.existsSync(path.join(d, '.autodev', 'PROGRAM.md')), 'program.md should be written');
  // Reminder must come before the task-begin marker.
  assert.ok(
    prompt.indexOf('<system-reminder>') < prompt.indexOf('NEXT TASK TO BEGIN'),
    'reminder must precede the task message',
  );
});

// ── R1c: subsequent turn (includeProfile=false) → no reminder. ──
ok('buildMessage: subsequent turn does NOT inject the reminder', () => {
  const d = tmpRoot();
  const { prompt } = buildMessage(task, d, d, false);
  assert.ok(!prompt.includes('<system-reminder>'), 'non-first turn must not carry the reminder');
});

// ── R2: rebuildProfile regenerates program.md but leaves SOUL.md untouched. ──
ok('rebuildProfile: pre-existing SOUL.md is never clobbered', () => {
  const d = tmpRoot();
  const soulPath = path.join(d, 'SOUL.md');
  const soulBody = '## My Identity\nName: Zephyr\nRole: drunken designer persona\n';
  fs.writeFileSync(soulPath, soulBody);

  rebuildProfile(d);

  // program.md was (re)generated…
  assert.ok(fs.existsSync(path.join(d, '.autodev', 'PROGRAM.md')), 'program.md should exist after rebuild');
  // …and it references SOUL.md as the identity anchor.
  const program = fs.readFileSync(path.join(d, '.autodev', 'PROGRAM.md'), 'utf8');
  assert.match(program, /file:\/\/\.\/SOUL\.md/, 'program.md must reference SOUL.md');
  // …but SOUL.md itself is byte-for-byte unchanged.
  assert.strictEqual(fs.readFileSync(soulPath, 'utf8'), soulBody, 'SOUL.md must be unchanged by rebuild');

  // A second rebuild must still leave the identity intact.
  rebuildProfile(d);
  assert.strictEqual(fs.readFileSync(soulPath, 'utf8'), soulBody, 'SOUL.md must survive repeated rebuilds');
});

console.log(`\nprogramReminder smoke: ${pass} passed`);
