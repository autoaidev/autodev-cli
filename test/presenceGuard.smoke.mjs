// Offline smoke — the duplicate-loop guard used by `autodev start`.
//
// A SECOND `autodev start` for a workspace must bail out when a DIFFERENT,
// still-alive loop already owns a FRESH .autodev/ws-presence.lock — else the two
// loops bind the same office slug and evict each other on the server's last-wins
// index every ~5s (a WebSocket flap). foreignLoopOwner() is the pure decision:
// it returns the owning pid to bail on, or null to proceed.
//
// Cases: live foreign lock → bail; dead pid → proceed; stale ts → proceed;
// no lock → proceed; own pid → proceed.
// Run: node test/presenceGuard.smoke.mjs   (after npm run build)
import assert from 'node:assert';

const { foreignLoopOwner } = await import('../out/presenceGuard.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const NOW = 1_000_000_000;
const alive = () => true;   // pretend every pid is alive
const dead = () => false;   // pretend every pid is dead

console.log('presenceGuard: foreignLoopOwner');

ok('live foreign lock, fresh ts → returns owner pid (bail)', () => {
  const r = foreignLoopOwner({ pid: 4242, slug: 's', ts: NOW - 10_000 }, { now: NOW, selfPid: 999, isAlive: alive });
  assert.strictEqual(r, 4242);
});

ok('dead pid → null (take over)', () => {
  const r = foreignLoopOwner({ pid: 4242, slug: 's', ts: NOW - 10_000 }, { now: NOW, selfPid: 999, isAlive: dead });
  assert.strictEqual(r, null);
});

ok('stale ts (older than freshMs) → null (take over)', () => {
  const r = foreignLoopOwner({ pid: 4242, slug: 's', ts: NOW - 120_000 }, { now: NOW, selfPid: 999, isAlive: alive });
  assert.strictEqual(r, null);
});

ok('no lock → null (proceed)', () => {
  assert.strictEqual(foreignLoopOwner(null, { now: NOW, selfPid: 999 }), null);
  assert.strictEqual(foreignLoopOwner(undefined, { now: NOW, selfPid: 999 }), null);
});

ok('own pid → null (never guard against ourselves)', () => {
  const r = foreignLoopOwner({ pid: 999, slug: 's', ts: NOW }, { now: NOW, selfPid: 999, isAlive: alive });
  assert.strictEqual(r, null);
});

ok('missing/zero pid → null', () => {
  assert.strictEqual(foreignLoopOwner({ ts: NOW }, { now: NOW, selfPid: 999, isAlive: alive }), null);
  assert.strictEqual(foreignLoopOwner({ pid: 0, ts: NOW }, { now: NOW, selfPid: 999, isAlive: alive }), null);
});

ok('exactly at freshMs boundary → stale → null', () => {
  const r = foreignLoopOwner({ pid: 4242, ts: NOW - 90_000 }, { now: NOW, selfPid: 999, freshMs: 90_000, isAlive: alive });
  assert.strictEqual(r, null);
});

console.log(`\npresenceGuard smoke: ${pass} checks passed`);
