// Smoke: SOUL.md re-read-on-update reminder (messageBuilder.soulUpdatedReminder).
// Simulates the office editing an agent's SOUL.md (a plain write, exactly what the
// mcp-operate file browser's `write` action does) and asserts the agent is told to
// re-read it — on the CONTENT-changed turn only, never spuriously.
//
// The gate is CONTENT-HASH based, not mtime: SOUL.md is re-touched every turn by
// callers that may rewrite it with IDENTICAL content (office persona/skills sync,
// file-browser write). An mtime-only gate fired the reminder every single turn even
// when nothing changed. These cases pin the content-hash behaviour:
//   (a) touched with identical content (mtime bumped, bytes same) → NO reminder
//   (b) content actually changed → reminder fires once, then silent until next change
//   (c) brand-new session (no marker) → silent on turn 1
//   (d) legacy mtime-integer marker from the old gate → migrated silently (no spam)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { soulUpdatedReminder } = require('../out/messageBuilder.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'soulupd-'));
fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
const soul = path.join(d, 'SOUL.md');
const marker = path.join(d, '.autodev', '.soul-seen');
// Bump ONLY the mtime, leaving content byte-identical — models the per-turn re-touch
// that an identical office persona/skills sync (or a re-write of the same bytes) does.
const bumpMtime = (secs) => fs.utimesSync(soul, new Date(secs * 1000), new Date(secs * 1000));

// No SOUL.md yet → silent.
ok(soulUpdatedReminder(d) === '', 'no SOUL.md → no reminder');

// (c) First observation / brand-new session: record the hash, stay silent — the
// first-turn profile reminder already covers the initial read; never fire turn 1.
fs.writeFileSync(soul, '# Soul\nName: Nova\n');
ok(soulUpdatedReminder(d) === '', 'brand-new session → no "was just UPDATED" on turn 1');
ok(fs.existsSync(marker), 'marker created on first observation');
ok(/^[0-9a-f]{64}$/.test(fs.readFileSync(marker, 'utf8').trim()), 'marker stores a sha256 content hash');

// No change → silent, repeatedly (even across turns).
ok(soulUpdatedReminder(d) === '', 'unchanged → silent');
ok(soulUpdatedReminder(d) === '', 'unchanged → still silent');

// (a) Re-touched with IDENTICAL content but a FRESH mtime → still silent. This is the
// exact spurious-every-turn bug: mtime advances but the bytes are the same.
fs.writeFileSync(soul, '# Soul\nName: Nova\n'); // rewrite same bytes
bumpMtime(5000);                                // advance mtime past any prior value
ok(soulUpdatedReminder(d) === '', 'identical content + bumped mtime → no reminder (the bug)');
bumpMtime(6000);
ok(soulUpdatedReminder(d) === '', 'identical content + bumped mtime again → still no reminder');

// (b) The OFFICE edits SOUL.md (content actually changes) → re-read reminder fires.
fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nYou are now a reviewer.\n');
const r = soulUpdatedReminder(d);
ok(r.includes('<system-reminder>') && /UPDATED/.test(r) && /Re-read `SOUL\.md`/.test(r), 'office content edit → re-read reminder emitted');

// Fires ONCE per change: not repeated until the NEXT content change (hash advanced).
ok(soulUpdatedReminder(d) === '', 'reminder fires once per change, not every turn');
bumpMtime(7000);
ok(soulUpdatedReminder(d) === '', 'mtime bump after an acknowledged edit → still silent');

// A second content edit fires again, then goes quiet.
fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nUpdated again.\n');
ok(/UPDATED/.test(soulUpdatedReminder(d)), 'second content edit → reminder again');
ok(soulUpdatedReminder(d) === '', 'silent after the second edit is acknowledged');

// (d) Legacy marker migration: a pre-hash gate left an mtime INTEGER in .soul-seen.
// First turn after upgrade must migrate it to a hash SILENTLY — not fire a bogus
// "was just UPDATED" just because the stored value isn't the new hash.
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'soulupd-legacy-'));
fs.mkdirSync(path.join(d2, '.autodev'), { recursive: true });
fs.writeFileSync(path.join(d2, 'SOUL.md'), '# Soul\nName: Legacy\n');
fs.writeFileSync(path.join(d2, '.autodev', '.soul-seen'), '1700000000000'); // old mtime marker
ok(soulUpdatedReminder(d2) === '', 'legacy mtime marker → migrated silently, no spurious reminder');
ok(/^[0-9a-f]{64}$/.test(fs.readFileSync(path.join(d2, '.autodev', '.soul-seen'), 'utf8').trim()), 'legacy marker upgraded to a content hash');
ok(soulUpdatedReminder(d2) === '', 'after migration, unchanged content stays silent');
fs.rmSync(d2, { recursive: true, force: true });

// END-TO-END: the OFFICE edits SOUL.md via the mcp-operate file browser `write`
// action (the exact path the office UI drives) → the reminder fires next turn.
const { handleFbRequest } = require('../out/fileBrowser.js');
let fbOk = null;
handleFbRequest({
  root: d, enabled: true, requestId: 'r1', action: 'write', relPath: 'SOUL.md',
  content: '# Soul\nName: Nova\n\n## Persona\nEdited from the office file browser.\n',
  sendFrame: (f) => { if (f && f.type === 'fb_response') { fbOk = f.ok; } },
});
ok(fbOk === true, 'office file-browser write to SOUL.md succeeded');
ok(fs.readFileSync(soul, 'utf8').includes('Edited from the office file browser'), 'SOUL.md updated by the office write');
ok(/UPDATED/.test(soulUpdatedReminder(d)), 'office file-browser edit → agent told to re-read SOUL.md');

fs.rmSync(d, { recursive: true, force: true });
console.log(`\nsoulUpdate smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
