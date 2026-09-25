// Run after `npm run build` (imports the compiled JS from out/).
// Verifies killProcessTree reaps a whole tree (parent + grandchildren) on the
// current platform, and that the win32 taskkill argv is built correctly.
import * as child_process from 'child_process';
import * as fs from 'fs';
import assert from 'assert';
import { killProcessTree, killProcessTreeByPids, taskkillArgs } from '../out/core/killProcessTree.js';

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  ok - ${msg}`); }
  else { console.error(`  FAIL - ${msg}`); failures++; }
}

// --- 1. win32 taskkill argv construction (pure, platform-independent) --------
assert.deepStrictEqual(taskkillArgs(1234), ['/PID', '1234', '/T', '/F']);
ok(true, 'taskkillArgs builds `/PID <pid> /T /F`');

// --- 2. guards: refuse pid <= 1 and non-integers (must not throw) ------------
killProcessTree(0);
killProcessTree(1);
killProcessTree(-5);
killProcessTree(NaN);
killProcessTreeByPids([]);
ok(true, 'guards (pid<=1, NaN, empty list) are safe no-ops');

const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

// Read direct children of a pid from /proc (Linux); [] elsewhere.
function childrenOf(pid) {
  const kids = [];
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) { continue; }
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(rest[1]) === pid) { kids.push(Number(name)); }
      } catch { /* vanished */ }
    }
  } catch { /* no /proc */ }
  return kids;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- 3. live tree kill on the current platform -------------------------------
// `sh -c 'sleep 300 & sleep 300'`: the sh (child.pid) has two sleep children.
const child = child_process.spawn('sh', ['-c', 'sleep 300 & sleep 300'], { stdio: 'ignore' });
await new Promise((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
await sleep(600); // let the grandchildren come up

const grandchildren = childrenOf(child.pid);
ok(alive(child.pid), 'parent sh is alive before kill');
if (process.platform === 'linux') {
  ok(grandchildren.length >= 2, `found ${grandchildren.length} grandchild sleep(s) before kill`);
}

killProcessTree(child.pid);

// Poll up to ~3s for the whole tree to die.
let deadline = Date.now() + 3000;
let allGone = false;
while (Date.now() < deadline) {
  const parentGone = !alive(child.pid);
  const kidsGone = grandchildren.every((p) => !alive(p));
  if (parentGone && kidsGone) { allGone = true; break; }
  await sleep(100);
}
try { child.kill('SIGKILL'); } catch { /* already dead */ }

ok(!alive(child.pid), 'parent sh is dead after killProcessTree');
if (process.platform === 'linux') {
  const survivors = grandchildren.filter((p) => alive(p));
  ok(survivors.length === 0, `all grandchildren reaped (survivors: ${survivors.join(',') || 'none'})`);
} else {
  ok(allGone, 'tree reaped (parent gone)');
}

if (failures) {
  console.error(`killProcessTree.smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('killProcessTree.smoke: PASS');
