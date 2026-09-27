// Unit smoke for the grok LEADER daemon (Layer B, 1.4.193): the LeaderPolicy
// decision, leader.json read/write, orphan-sweep, the flag-off no-op, the leader
// client launch spec, and AcpSession attach-without-load (no session/load) vs the
// unchanged session/load path — all offline against the fake ACP agent.
//
// Run: node test/grokLeader.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const { AcpSession, decodeAcpUpdateStandard } = await import('../out/providers/acp/AcpSession.js');
const { GROK_ACP_SPEC, grokLeaderClientSpec, GrokAcpSession } = await import('../out/providers/grok/GrokAcpSession.js');
const leader = await import('../out/providers/grok/leader.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ✓', name); pass++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-leader-')); }

console.log('grokLeader: Layer B leader daemon');

// --- flag gate (DEFAULT OFF) ----------------------------------------------
ok('leaderModeEnabled: DEFAULT OFF; on only for 1/true/on/yes', () => {
  assert.equal(leader.leaderModeEnabled({}), false);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: '' }), false);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: '0' }), false);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: 'off' }), false);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: '1' }), true);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: 'true' }), true);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: 'ON' }), true);
  assert.equal(leader.leaderModeEnabled({ AUTODEV_GROK_LEADER: 'yes' }), true);
});

// --- FLAG-OFF NO-OP: the non-leader launch spec is byte-for-byte unchanged --
ok('flag-off: GROK_ACP_SPEC still emits --no-leader (unchanged)', () => {
  assert.deepEqual(GROK_ACP_SPEC.buildArgs('grok-code', []), ['agent', '--always-approve', '-m', 'grok-code', '--no-leader', 'stdio']);
  assert.deepEqual(GROK_ACP_SPEC.buildArgs(undefined, []), ['agent', '--always-approve', '--no-leader', 'stdio']);
});

// --- leader client launch spec --------------------------------------------
ok('grokLeaderClientSpec: --leader --leader-socket replaces --no-leader', () => {
  const spec = grokLeaderClientSpec('/tmp/x.sock');
  assert.deepEqual(spec.buildArgs('grok-code', []), ['agent', '--always-approve', '-m', 'grok-code', '--leader', '--leader-socket', '/tmp/x.sock', 'stdio']);
  assert.deepEqual(spec.buildArgs(undefined, []), ['agent', '--always-approve', '--leader', '--leader-socket', '/tmp/x.sock', 'stdio']);
});

// --- socket path: deterministic + long-path fallback ----------------------
ok('leaderSocketPath: .autodev for short roots, hashed tmp for long', () => {
  const shortRoot = '/tmp/a';
  assert.equal(leader.leaderSocketPath(shortRoot), path.join(shortRoot, '.autodev', 'grok-leader.sock'));
  const longRoot = '/tmp/' + 'x'.repeat(120);
  const p = leader.leaderSocketPath(longRoot);
  assert.ok(p.startsWith(os.tmpdir()) && p.endsWith('.sock'), 'long root → hashed tmp socket');
  assert.equal(leader.leaderSocketPath(longRoot), p, 'deterministic for the same root');
  assert.ok(Buffer.byteLength(p) <= 108, 'stays under sun_path limit');
});

// --- leader.json read/write/remove roundtrip ------------------------------
ok('leader.json: write/read/remove roundtrip', () => {
  const root = tmpRoot();
  assert.equal(leader.readLeaderInfo(root), null);
  const info = { pid: 12345, socket: '/tmp/s.sock', startedAt: new Date().toISOString(), keepalivePid: 12346, sessionId: 'abc', root };
  leader.writeLeaderInfo(root, info);
  const back = leader.readLeaderInfo(root);
  assert.equal(back.pid, 12345);
  assert.equal(back.keepalivePid, 12346);
  assert.equal(back.sessionId, 'abc');
  leader.removeLeaderInfo(root);
  assert.equal(leader.readLeaderInfo(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- orphan-sweep decision (PURE) -----------------------------------------
ok('decideLeaderAction: spawn / adopt / reap-stale', () => {
  assert.equal(leader.decideLeaderAction(null, { leader: false, keepalive: false, socket: false }), 'spawn');
  const info = { pid: 1, socket: 's', startedAt: '', keepalivePid: 2 };
  assert.equal(leader.decideLeaderAction(info, { leader: true, keepalive: true, socket: true }), 'adopt');
  assert.equal(leader.decideLeaderAction(info, { leader: false, keepalive: true, socket: true }), 'reap-stale', 'dead leader → reap');
  assert.equal(leader.decideLeaderAction(info, { leader: true, keepalive: false, socket: true }), 'reap-stale', 'dead keepalive → reap');
  assert.equal(leader.decideLeaderAction(info, { leader: true, keepalive: true, socket: false }), 'reap-stale', 'missing socket → reap');
  // no keepalivePid recorded → keepalive liveness is not required
  assert.equal(leader.decideLeaderAction({ pid: 1, socket: 's', startedAt: '' }, { leader: true, keepalive: false, socket: true }), 'adopt');
});

// --- isPidAlive ------------------------------------------------------------
ok('isPidAlive: self alive, bogus dead', () => {
  assert.equal(leader.isPidAlive(process.pid), true);
  assert.equal(leader.isPidAlive(2 ** 30), false);
  assert.equal(leader.isPidAlive(0), false);
  assert.equal(leader.isPidAlive(undefined), false);
});

// --- isUnknownSessionError classifier -------------------------------------
ok('AcpSession.isUnknownSessionError: matches leader eviction messages', () => {
  assert.equal(AcpSession.isUnknownSessionError('unknown session id'), true);
  assert.equal(AcpSession.isUnknownSessionError('Invalid params: no such session'), true);
  assert.equal(AcpSession.isUnknownSessionError('rate limited'), false);
  assert.equal(AcpSession.isUnknownSessionError(undefined), false);
});

// --- ATTACH-WITHOUT-LOAD vs session/load (behavioural, fake agent) ---------
function makeSession(initialSessionId, attachWithoutLoad, logFile) {
  const events = [];
  const spec = { buildArgs: () => [FAKE], narrationTitle: 'test', decodeUpdate: decodeAcpUpdateStandard };
  const sess = new AcpSession({
    root: process.cwd(), bin: process.execPath, spec, initialSessionId, attachWithoutLoad,
    hooks: { emitHook: (name, extra) => events.push({ name, extra }), log: () => {} },
    extraEnv: logFile ? { FAKE_ACP_LOG: logFile } : {},
  });
  return { sess, events };
}

await okAsync('attach-without-load: leader mode adopts the id WITHOUT session/load', async () => {
  const logFile = path.join(tmpRoot(), 'methods.log');
  const { sess } = makeSession('fake-1', true, logFile); // attachWithoutLoad=true
  await sess.ensureReady();
  assert.equal(sess.sessionId, 'fake-1', 'adopted the persisted id');
  assert.equal(sess.attachMode, true);
  const methods = fs.readFileSync(logFile, 'utf8');
  assert.ok(!methods.includes('session/load'), 'NO session/load sent (attach-without-load)');
  assert.ok(methods.includes('session/list'), 'used session/list to verify the id');
  // a real turn still works on the attached session
  await sess.runTurn('hello attached', () => {});
  sess.close();
  fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
});

await okAsync('flag-off path: attachWithoutLoad=false still session/loads (unchanged)', async () => {
  const logFile = path.join(tmpRoot(), 'methods2.log');
  const { sess } = makeSession('fake-1', false, logFile); // classic path
  await sess.ensureReady();
  assert.equal(sess.attachMode, false);
  const methods = fs.readFileSync(logFile, 'utf8');
  assert.ok(methods.includes('session/load'), 'session/load IS sent when not attaching (byte-for-byte prior behaviour)');
  sess.close();
  fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
});

// --- GrokAcpSession picks the right spec ------------------------------------
ok('GrokAcpSession: leaderSocket → leader client spec; none → non-leader', () => {
  const nonLeader = new GrokAcpSession({ root: process.cwd(), bin: 'grok', hooks: { emitHook() {}, log() {} } });
  assert.equal(nonLeader.attachMode, false);
  const led = new GrokAcpSession({ root: process.cwd(), bin: 'grok', hooks: { emitHook() {}, log() {} }, leaderSocket: '/tmp/y.sock', attachWithoutLoad: true });
  assert.equal(led.attachMode, true);
});

// --- stopLeader: reaps a live pid + cleans files --------------------------
await okAsync('stopLeader: kills recorded pids + removes socket/sid/json', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.autodev'), { recursive: true });
  const sock = path.join(root, '.autodev', 'grok-leader.sock');
  const sid = path.join(root, '.autodev', 'grok-leader.sid');
  // two long-lived dummy processes to stand in for leader + keepalive
  const p1 = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  const p2 = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  fs.writeFileSync(sock, ''); fs.writeFileSync(sid, 'fake-1');
  leader.writeLeaderInfo(root, { pid: p1.pid, socket: sock, startedAt: new Date().toISOString(), keepalivePid: p2.pid, sessionId: 'fake-1', root });
  const killed = leader.stopLeader(root, () => {});
  assert.equal(killed, true, 'reported a reap');
  await sleep(400);
  assert.equal(leader.isPidAlive(p1.pid), false, 'leader pid dead');
  assert.equal(leader.isPidAlive(p2.pid), false, 'keepalive pid dead');
  assert.equal(fs.existsSync(sock), false, 'socket removed');
  assert.equal(fs.existsSync(sid), false, 'sid removed');
  assert.equal(leader.readLeaderInfo(root), null, 'leader.json removed');
  fs.rmSync(root, { recursive: true, force: true });
});

await okAsync('stopLeader: no leader.json → no-op false', async () => {
  const root = tmpRoot();
  assert.equal(leader.stopLeader(root, () => {}), false);
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\ngrokLeader: ${pass} checks passed`);
