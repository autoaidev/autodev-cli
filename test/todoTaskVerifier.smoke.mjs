// Unit smoke for the verify-and-re-append task backstop (TodoTaskVerifier).
//
// Proves the fix for the reported bug: a WS-pushed task that a grok-acp turn
// CLOBBERS out of TODO.md is re-appended by the poller until durably present,
// idempotently (never a duplicate line), the task_ack is NOT sent until the
// task is confirmed durable, and a task that is simply present acks once and
// the poller stops (no churn for claude / non-grok providers).
//
// It drives the verifier with an in-memory TODO.md model + tick() calls so the
// logic is tested deterministically without a socket or timers.
//
// Also exercises the real idempotent append (appendTaskIfAbsent) against a file.
//
// Run: node test/todoTaskVerifier.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { TodoTaskVerifier } = await import('../out/todoTaskVerifier.js');
const { appendTaskIfAbsent, appendTask, parseTodo } = await import('../out/todo.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const flush = () => new Promise(r => setImmediate(r)); // let appendIfAbsent promise settle

console.log('todoTaskVerifier: verify-and-re-append backstop');

// A tiny in-memory TODO model shared by the verifier's readState + appendIfAbsent.
function makeTodo() {
  const open = new Set();   // ids present as [ ] / [~]
  const done = new Set();   // ids present as [x]
  const appendLog = [];     // every id appendIfAbsent actually wrote
  return {
    open, done, appendLog,
    readState: () => ({ present: new Set(open), done: new Set(done) }),
    appendIfAbsent: async (id) => {            // idempotent by id (mirror real impl)
      if (open.has(id) || done.has(id)) { return; }
      open.add(id);
      appendLog.push(id);
    },
    clobber: (id) => { open.delete(id); },     // grok rewrites TODO.md, dropping the line
    complete: (id) => { open.delete(id); done.add(id); },
  };
}

function makeVerifier(todo, confirmTicks = 2) {
  const acks = [];
  const v = new TodoTaskVerifier({
    confirmTicks,
    readState: todo.readState,
    appendIfAbsent: todo.appendIfAbsent,
    sendAck: (dbId) => acks.push(dbId),
    log: () => {},
  });
  return { v, acks };
}

// --- 1. grok clobber is repaired; ack deferred until durable ----------------
await okAsync('grok clobber: re-appends until present, acks only once durable, no dup line', async () => {
  const todo = makeTodo();
  const { v, acks } = makeVerifier(todo, 2);

  // Task delivered: immediate append happened at the WS layer (model it), then tracked.
  await todo.appendIfAbsent('t1');
  v.track('t1', 'do the thing', 'db-1');
  assert.deepEqual(todo.appendLog, ['t1'], 'one line after delivery');

  // Tick 1: present → presentTicks=1, NOT yet acked.
  v.tick(); await flush();
  assert.equal(acks.length, 0, 'ack deferred after 1 present tick');
  assert.equal(v.has('t1'), true, 'still tracked');

  // grok clobbers the line mid-turn.
  todo.clobber('t1');

  // Tick 2: absent → re-append (repair) + reset count. Still no ack.
  v.tick(); await flush();
  assert.equal(acks.length, 0, 'ack still deferred while repairing clobber');
  assert.deepEqual(todo.appendLog, ['t1', 't1'], 're-appended exactly once on clobber');
  assert.equal(todo.open.has('t1'), true, 'task line restored');

  // Tick 3: present again → presentTicks=1.
  v.tick(); await flush();
  assert.equal(acks.length, 0, 'one present tick after repair — not durable yet');

  // Tick 4: present → presentTicks=2 ⇒ durable ⇒ ack once + stop tracking.
  v.tick(); await flush();
  assert.deepEqual(acks, ['db-1'], 'acked exactly once when durably present');
  assert.equal(v.has('t1'), false, 'stopped tracking once confirmed');
  assert.equal(v.size, 0, 'no tasks left ⇒ poller idle');

  // No duplicate line was ever produced across the whole dance.
  assert.equal(todo.appendLog.filter(x => x === 't1').length, 2, 'only the delivery + one repair write');
});

// --- 2. a task that just stays present acks once, no re-append (claude path) -
await okAsync('already present: acks once after confirm ticks, never re-appends, stops', async () => {
  const todo = makeTodo();
  const { v, acks } = makeVerifier(todo, 2);
  await todo.appendIfAbsent('t2');
  v.track('t2', 'write a test', 'db-2');

  v.tick(); await flush();                 // present → 1
  v.tick(); await flush();                 // present → 2 ⇒ ack + stop
  assert.deepEqual(acks, ['db-2'], 'acked exactly once');
  assert.deepEqual(todo.appendLog, ['t2'], 'never re-appended (no clobber, no churn)');
  assert.equal(v.size, 0, 'poller stops immediately once confirmed');
});

// --- 3. completion before confirm: ack + forget, never resurrect ------------
await okAsync('completed task: acks + stops, is never re-appended even if later pruned', async () => {
  const todo = makeTodo();
  const { v, acks } = makeVerifier(todo, 2);
  await todo.appendIfAbsent('t3');
  v.track('t3', 'quick task', 'db-3');

  v.tick(); await flush();                 // present → 1 (not yet durable)
  assert.equal(acks.length, 0);
  todo.complete('t3');                      // agent finished it fast

  v.tick(); await flush();                 // seen done ⇒ ack + forget
  assert.deepEqual(acks, ['db-3'], 'done task acked');
  assert.equal(v.has('t3'), false, 'forgotten');

  // Simulate a later prune that removes the [x] line entirely.
  todo.done.delete('t3');
  v.tick(); await flush();
  assert.equal(todo.appendLog.filter(x => x === 't3').length, 1, 'completed task NOT resurrected');
});

// --- 4. re-track (office re-push under a new delivery id) is idempotent ------
await okAsync('re-track same id refreshes without losing progress or duplicating', async () => {
  const todo = makeTodo();
  const { v, acks } = makeVerifier(todo, 2);
  await todo.appendIfAbsent('t4');
  v.track('t4', 'v1', 'db-4');
  v.tick(); await flush();                 // present → 1
  v.track('t4', 'v1', 'db-4');             // office re-pushed the same DB task
  assert.equal(v.size, 1, 'still a single tracked task');
  v.tick(); await flush();                 // present → 2 ⇒ ack
  assert.deepEqual(acks, ['db-4'], 'acked once despite re-track');
});

// --- 5. no dbTaskId (old server frame): verifier still repairs, no ack sent --
await okAsync('task with no dbTaskId: repaired + stops, sends no ack', async () => {
  const todo = makeTodo();
  const { v, acks } = makeVerifier(todo, 1);
  await todo.appendIfAbsent('t5');
  v.track('t5', 'legacy', undefined);
  v.tick(); await flush();                 // present → confirm (confirmTicks=1) ⇒ stop, no ack
  assert.equal(acks.length, 0, 'nothing to ack without a dbTaskId');
  assert.equal(v.size, 0, 'stopped');
});

// --- 6. stop() clears tracking + timer --------------------------------------
ok('stop() clears tracked tasks', () => {
  const todo = makeTodo();
  const { v } = makeVerifier(todo, 2);
  v.track('a', 'x', 'db-a');
  v.track('b', 'y', 'db-b');
  assert.equal(v.size, 2);
  v.stop();
  assert.equal(v.size, 0, 'all forgotten on teardown');
});

// --- 7. real appendTaskIfAbsent is idempotent by id on a real file ----------
ok('appendTaskIfAbsent: idempotent by id against a real TODO.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-verify-'));
  const file = path.join(dir, 'TODO.md');
  fs.writeFileSync(file, '## Todo\n', 'utf8');
  const id = 'task-2026-10-31-aaaaaa';
  appendTaskIfAbsent(file, 'first append', id);
  appendTaskIfAbsent(file, 'should be ignored', id); // same id ⇒ no-op
  const tasks = parseTodo(file).filter(t => t.id === id);
  assert.equal(tasks.length, 1, 'exactly one line for the id');
  assert.equal(tasks[0].text, 'first append', 'original text kept');

  // Present as [x] done also counts as present ⇒ still no re-append.
  fs.writeFileSync(file, `## Todo\n## Done\n- [x] 2026-10-31  [${id}] done one\n`, 'utf8');
  appendTaskIfAbsent(file, 'resurrect?', id);
  assert.equal(parseTodo(file).filter(t => t.id === id).length, 1, 'done task not duplicated');
});

console.log(`todoTaskVerifier: ${pass} checks passed`);
