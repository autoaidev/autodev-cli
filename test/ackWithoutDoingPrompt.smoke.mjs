// Offline smoke — prompt hardening against ACK-without-doing (1.4.194 FIX 2).
//
// grok/opencode auto-mode sometimes closes a turn on an INTENTION ("I will do X")
// without producing the deliverable. The per-turn task instruction is hardened to
// require a CONCRETE deliverable + an explicit [x] before a task is done, and to
// FORBID ending a turn on acknowledgement/intention alone.
//
// CRITICAL (reminder-dispatch-seam): the model reads the messageFile that
// buildMessage writes (via writeCombinedFile), NOT the returned `prompt` string,
// so the hardened wording must land IN THE MESSAGEFILE — this test asserts exactly
// that by reading the file buildMessage wrote to disk.
// Run: node test/ackWithoutDoingPrompt.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildMessage } = await import('../out/messageBuilder.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('messageBuilder: ACK-without-doing hardening lands in the messageFile');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-ackprompt-'));
fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
fs.writeFileSync(path.join(root, 'TODO.md'), '# TODO\n\n- [ ] Build the widget and save it to widget.js\n', 'utf8');

const task = { text: 'Build the widget and save it to widget.js', line: 3, status: 'pending', id: 'w1' };
const { prompt, messageFile } = buildMessage(task, root, root, /*includeProfile*/ true, /*resumedTurn*/ false);

const fileContent = fs.readFileSync(messageFile, 'utf8');

ok('messageFile exists and is what the model reads (writeCombinedFile source)', () => {
  assert.ok(fs.existsSync(messageFile), 'messageFile was written to disk');
  assert.ok(fileContent.length > 0, 'messageFile is non-empty');
});

ok('requires a CONCRETE deliverable before [x] (not "just mark done")', () => {
  assert.match(fileContent, /concrete deliverable actually exists/i, 'demands a concrete deliverable exists before marking done');
  assert.match(fileContent, /file created or edited|command run with its result|verifiable change/i, 'spells out what a deliverable is');
});

ok('FORBIDS closing a turn on acknowledgement / intention alone', () => {
  assert.match(fileContent, /PRODUCED DELIVERABLE, never with an intention/i, 'a turn ends with a deliverable, not an intention');
  assert.match(fileContent, /do not reply that you \*will\* do/i, 'explicitly forbids "I will do X" as a closing move');
  assert.match(fileContent, /NOT progress/i, 'a plan-restating turn is explicitly not progress');
  assert.match(fileContent, /"I will do it" is not acceptable/i, 'the loop-standing note also rejects the intention-only close');
});

ok('still demands the explicit [x] mark on a real completion', () => {
  assert.match(fileContent, /\[x\]/, 'the done marker instruction is present');
  assert.ok(!/Never write `\[x\]` unless the deliverable is really there/i.test(fileContent) === false,
    'guards [x] on a real deliverable');
});

ok('the returned prompt mirrors the messageFile ordering (both carry the hardening)', () => {
  assert.match(prompt, /PRODUCED DELIVERABLE, never with an intention/i, 'returned prompt also carries the hardening');
});

// cleanup
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} assertions passed ✓`);
