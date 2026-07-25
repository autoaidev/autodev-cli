// Smoke: SOUL.md re-read-on-update reminder (messageBuilder.soulUpdatedReminder).
// Simulates the office editing an agent's SOUL.md (a plain write, exactly what the
// mcp-operate file browser's `write` action does) and asserts the agent is told to
// re-read it — on the changed turn only, never spuriously.
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
const setMtime = (secs) => fs.utimesSync(soul, new Date(secs * 1000), new Date(secs * 1000));

// No SOUL.md yet → silent.
ok(soulUpdatedReminder(d) === '', 'no SOUL.md → no reminder');

// First observation: record the marker, stay silent (first-turn reminder covers the initial read).
fs.writeFileSync(soul, '# Soul\nName: Nova\n');
setMtime(1000);
ok(soulUpdatedReminder(d) === '', 'first observation is silent');
ok(fs.existsSync(marker), 'marker created on first observation');

// No change → silent, repeatedly.
ok(soulUpdatedReminder(d) === '', 'unchanged → silent');
ok(soulUpdatedReminder(d) === '', 'unchanged → still silent');

// The OFFICE edits SOUL.md (a write advances mtime) → re-read reminder fires.
fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nYou are now a reviewer.\n');
setMtime(2000);
const r = soulUpdatedReminder(d);
ok(r.includes('<system-reminder>') && /UPDATED/.test(r) && /Re-read `SOUL\.md`/.test(r), 'office edit → re-read reminder emitted');

// Not repeated until the NEXT change (marker advanced).
ok(soulUpdatedReminder(d) === '', 'reminder fires once per change, not every turn');

// A second office edit fires again.
fs.writeFileSync(soul, '# Soul\nName: Nova\n\n## Persona\nUpdated again.\n');
setMtime(3000);
ok(/UPDATED/.test(soulUpdatedReminder(d)), 'second edit → reminder again');
ok(soulUpdatedReminder(d) === '', 'silent after the second edit is acknowledged');

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
