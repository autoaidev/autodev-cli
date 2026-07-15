// Offline smoke — the opencode event filter, asserted on the REAL artifact.
//
// opencode's plugin bus carries two very different things:
//   • what the AGENT did (tool calls, messages, session lifecycle) — the chat
//   • opencode wiring ITSELF up (plugin/catalog/integration/reference registry
//     churn, FS-watcher ticks, session status pings) — pure noise
//
// The office has no allowlist: unmapped event names pass through verbatim into
// hook_events and onto the user's chat timeline. Measured on one live 30-minute
// opencode turn, the noise OUTNUMBERED the signal — 405 plugin.added + 188
// catalog.updated + 466 session.updated vs 379 agent messages — so each cost a
// WS frame, a DB row and a line of the user's chat.
//
// The filter lives inside the plugin SOURCE that installOpenCodeHooks() writes
// into the workspace (it runs inside opencode, not in this process), so assert
// the emitted file rather than a module export — that's the thing that actually
// runs. Locks both directions: the noise stays dropped, and the events the chat
// is built from are never swallowed by an over-eager filter.
// Run: node test/opencodeEventFilter.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import hooks from '../out/openCodeHooksManager.js';
const { installOpenCodeHooks, isOpenCodeHooksInstalled } = hooks;

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('opencode event filter smoke');

// Emit the plugin into a throwaway workspace and read what opencode would run.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-ocfilter-')));
installOpenCodeHooks(root);
assert.ok(isOpenCodeHooksInstalled(root), 'plugin installed into the temp workspace');

const found = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); } else if (/\.(ts|js|mjs)$/.test(e.name)) { found.push(p); }
  }
};
walk(root);
const pluginFile = found.find(f => fs.readFileSync(f, 'utf8').includes('SKIP_EVENTS'));
assert.ok(pluginFile, 'emitted plugin file containing SKIP_EVENTS was found');
const src = fs.readFileSync(pluginFile, 'utf8');

/** The literal SKIP_EVENTS set as emitted, so `keep` checks can't false-pass on
 *  a name that merely appears elsewhere in the plugin (e.g. in SESSION_MAP). */
const skipBlock = src.slice(src.indexOf('SKIP_EVENTS'), src.indexOf(']);', src.indexOf('SKIP_EVENTS')));
const skips = (n) => new RegExp(`['"\`]${n.replace(/\./g, '\\.')}['"\`]`).test(skipBlock);

// ---------------------------------------------------------------------------
// 1. The noise must be dropped.
// ---------------------------------------------------------------------------
ok('drops opencode internal registry/bookkeeping events', () => {
  for (const e of [
    'plugin.added', 'catalog.updated', 'integration.updated',
    'reference.updated', 'file.watcher.updated', 'session.updated', 'session.status',
  ]) {
    assert.ok(skips(e), `${e} should be in SKIP_EVENTS (it floods the chat timeline)`);
  }
});

// ---------------------------------------------------------------------------
// 2. The signal must survive — the half that actually matters. A filter that
//    ate session.idle or the text accumulator would silently gut the chat.
// ---------------------------------------------------------------------------
ok('never drops the events the chat timeline is built from', () => {
  for (const e of [
    'session.created', 'session.idle', 'session.error', 'session.compacted',
    'session.next.text.ended', 'session.next.prompted', 'session.next.tool.failed',
    'todo.updated', 'session.next.model.switched', 'session.next.agent.switched',
  ]) {
    assert.ok(!skips(e), `${e} must NOT be skipped — the chat needs it`);
  }
});

// ---------------------------------------------------------------------------
// 3. The skipped bookkeeping must not linger in SESSION_MAP: a mapping for an
//    event we always drop is dead code that reads as if it were reachable.
// ---------------------------------------------------------------------------
ok('no dead SESSION_MAP entries for skipped events', () => {
  for (const dead of ['SessionStatus', 'FileWatcherUpdated']) {
    assert.ok(!src.includes(`'${dead}'`), `${dead} mapping is unreachable — remove it`);
  }
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
