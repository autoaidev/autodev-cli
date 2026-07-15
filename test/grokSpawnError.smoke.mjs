// Offline smoke — a MISSING provider binary must fail the turn, not hang it.
//
// The bug this locks (found live, then root-caused): grokTuiProvider guarded
// spawn() with a SYNCHRONOUS try/catch. `spawn()` does NOT throw on ENOENT — it
// emits 'error' asynchronously — so with no 'error' handler the failure escaped
// to start.ts's uncaughtException backstop, which keeps the process alive:
//   • 'close' never fired        → the exit file stayed empty
//   • _busyRoots was never cleared
//   • SessionStart had ALREADY been emitted before the child was confirmed
// Net effect: the office showed the agent WORKING, forever, on a grok that was
// never running. The only trace was `spawn grok ENOENT` buried in agent.log.
// Observed for real on vmin-box, where grok simply wasn't installed.
//
// This test asserts the CONTRACT at the node level (spawn's real semantics) and
// the SHAPE of the provider (an async error handler exists, and SessionStart is
// gated on 'spawn'), because driving the full task loop offline would need grok.
// Run: node test/grokSpawnError.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };

console.log('grok spawn-error smoke');

// ---------------------------------------------------------------------------
// 1. The premise. If this ever fails, node changed and the fix can be reverted.
// ---------------------------------------------------------------------------
await okAsync("node's spawn() does NOT throw on an unrunnable binary — it emits 'error'", async () => {
  let threw = false;
  let errEvent = null;
  try {
    const child = spawn('definitely-not-a-real-binary-xyz', ['--version']);
    errEvent = await new Promise((resolve) => {
      child.on('error', resolve);
      child.on('close', () => resolve(null));
    });
  } catch {
    threw = true;
  }
  // THE point: the failure arrives asynchronously, so a try/catch around spawn()
  // can never see it. That is precisely why the old guard was dead code.
  assert.strictEqual(threw, false, 'spawn must NOT throw synchronously — that is why try/catch was dead code');
  assert.ok(errEvent, "an async 'error' event must be emitted");
  // The errno is environment-dependent and deliberately NOT asserted exactly:
  // a missing binary is ENOENT in the real world, but a sandbox that denies exec
  // reports EACCES. Pinning ENOENT would make this test fail for the wrong reason.
  // The fix keys on the EVENT (and only special-cases ENOENT for its message).
  assert.ok(errEvent.code, `the error carries an errno (saw ${errEvent.code})`);
});

// ---------------------------------------------------------------------------
// 2. The provider must handle that event — the whole point of the fix.
// ---------------------------------------------------------------------------
const src = fs.readFileSync(path.join(here, '..', 'src', 'providers', 'grokTuiProvider.ts'), 'utf8');

ok("grokTui registers an async child.on('error') handler", () => {
  assert.ok(/child\.on\('error'/.test(src), "without this, ENOENT escapes and the turn hangs forever");
});

ok('the error path writes the exit file and clears the busy root', () => {
  const fail = src.slice(src.indexOf('const failSpawn'), src.indexOf('let child'));
  assert.ok(/writeFileSync\(exitFile/.test(fail), 'exit file is what the loop waits on — no write, no end of turn');
  assert.ok(/_busyRoots\.delete\(root\)/.test(fail), 'a stuck busy root blocks every later turn for this workspace');
  assert.ok(/_activeChildren\.delete\(root\)/.test(fail), 'drop the dead child reference');
});

ok('ENOENT is reported as a MISSING BINARY, not a bare errno', () => {
  assert.ok(/ENOENT/.test(src) && /not installed or not on PATH/.test(src),
    'the operator must be told what to actually do about it');
});

// ---------------------------------------------------------------------------
// 3. SessionStart must not fire before the child exists — emitting it early is
//    what let a failed turn masquerade as an active one in the office.
// ---------------------------------------------------------------------------
ok("SessionStart is gated on the 'spawn' event, not emitted optimistically", () => {
  assert.ok(/child\.once\('spawn'[\s\S]{0,120}SessionStart/.test(src),
    'SessionStart must only fire once the child is confirmed running');
  const beforeChild = src.slice(0, src.indexOf("child.once('spawn'"));
  const stray = beforeChild.match(/_emitGrokHook\(root, 'SessionStart'/g) || [];
  assert.strictEqual(stray.length, 0, 'no SessionStart may be emitted before the spawn is confirmed');
});

// ---------------------------------------------------------------------------
// 4. opencode already did this right — keep it that way (it is the reference).
// ---------------------------------------------------------------------------
ok('opencodeCli still handles spawn errors (the reference implementation)', () => {
  const oc = fs.readFileSync(path.join(here, '..', 'src', 'providers', 'opencodeCliProvider.ts'), 'utf8');
  assert.ok(/\.on\('error'/.test(oc), 'opencode must keep its async error handling');
});

console.log(`\n${pass} checks passed`);
