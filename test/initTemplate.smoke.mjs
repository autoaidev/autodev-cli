// Offline smoke — a brand-new agent's TODO.md must contain NO work of its own.
//
// Two real defects this locks, both hit on a fresh workspace:
//
// 1. WASTED FIRST TURN. The template shipped
//      - [ ] Example task — replace with your real task
//    which is a real, executable task: pickNextTask() returns the first `todo` in
//    FILE ORDER, so a brand-new agent spent its very first LLM call doing nothing
//    of value, and the customer's actual task ran second.
//
// 2. TWO TASK LISTS. The template's heading was "## Tasks" but appendTask() looks
//    for "## Todo" and CREATES that section when it is missing — so assigning the
//    first task left the workspace with two separate lists, the placeholder alone
//    at the top.
//
// The guidance in the template is deliberately prose: the task parser
// (/^\s*(?:-\s*)?\[\s+\]\s*(.+)$/) is whitespace-tolerant, so an example checkbox
// is executed even when indented inside an HTML comment.
// Run: node test/initTemplate.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// pickNextTask is what the loop itself calls to choose the turn's work — assert
// against that rather than re-implementing the selection here.
const { appendTask, parseTodoContent, pickNextTask } = await import('../out/todo.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// Read the template straight from source — the thing that actually ships.
const initSrc = fs.readFileSync(path.join(here, '..', 'src', 'commands', 'init.ts'), 'utf8');
const m = initSrc.match(/const TODO_TEMPLATE = `([\s\S]*?)`;/);
assert.ok(m, 'TODO_TEMPLATE must be findable in init.ts');
const TEMPLATE = m[1];

const write = (content) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-init-'));
  const f = path.join(d, 'TODO.md');
  fs.writeFileSync(f, content);
  return f;
};
/** Every line the loop would execute, exactly as todo.ts matches them. */
const executable = (s) => [...s.matchAll(/^\s*(?:-\s*)?\[\s+\]\s*(.+)$/gmu)].map((x) => x[1]);

console.log('init TODO template smoke');

// ---------------------------------------------------------------------------
// 1. A fresh workspace must give the agent nothing to do.
// ---------------------------------------------------------------------------
ok('a fresh TODO.md contains ZERO executable tasks', () => {
  const found = executable(TEMPLATE);
  assert.deepStrictEqual(found, [],
    `a new agent must not start with work of its own — would have run: ${JSON.stringify(found)}`);
});

ok('the template ships no "Example task" placeholder', () => {
  assert.ok(!/Example task/i.test(TEMPLATE), 'the placeholder cost every new agent its first LLM call');
});

// ---------------------------------------------------------------------------
// 2. The heading must be the one appendTask actually targets.
// ---------------------------------------------------------------------------
ok('the template heading matches what appendTask looks for (## Todo)', () => {
  const headings = [...TEMPLATE.matchAll(/^## .+$/gm)].map((x) => x[0].trim());
  assert.deepStrictEqual(headings, ['## Todo'],
    'a mismatched heading makes appendTask create a SECOND list');
});

// ---------------------------------------------------------------------------
// 3. The behaviour that matters: assign one task → exactly that task runs.
// ---------------------------------------------------------------------------
ok('assigning the first task yields ONE list and ONE task — the real one', () => {
  const f = write(TEMPLATE);
  appendTask(f, 'MY REAL TASK');
  const out = fs.readFileSync(f, 'utf8');

  const headings = [...out.matchAll(/^## .+$/gm)].map((x) => x[0].trim());
  assert.deepStrictEqual(headings, ['## Todo'], 'must not split into two task lists');

  const tasks = executable(out);
  assert.strictEqual(tasks.length, 1, `exactly one task should be runnable, got ${JSON.stringify(tasks)}`);
  assert.ok(tasks[0].includes('MY REAL TASK'), "and it must be the customer's task");
});

ok("the FIRST task the loop picks is the customer's, not a placeholder", () => {
  const f = write(TEMPLATE);
  appendTask(f, 'CUSTOMER TASK');
  // Exactly what the loop does: parse the file, take the next todo.
  const first = pickNextTask(parseTodoContent(fs.readFileSync(f, 'utf8')));
  assert.ok(first, 'a pending task must be found');
  assert.ok(first.text.includes('CUSTOMER TASK'),
    `the first turn must do the customer's work, not "${first.text}"`);
});

// ---------------------------------------------------------------------------
// 4. The guidance must not itself be executable (the trap this dodges).
// ---------------------------------------------------------------------------
ok('the in-template guidance cannot be parsed as a task, even indented', () => {
  assert.ok(/<!--/.test(TEMPLATE), 'guidance is present for a new user');
  assert.deepStrictEqual(executable(TEMPLATE), [],
    'the parser is whitespace-tolerant — an example checkbox would run even inside a comment');
});

console.log(`\n${pass} checks passed`);
