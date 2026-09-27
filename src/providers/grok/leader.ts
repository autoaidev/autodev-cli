// ---------------------------------------------------------------------------
// grok LEADER daemon — "always open, reconnect-never-reload" (Layer B, 1.4.193).
//
// GOAL: the grok backend OUTLIVES loop/app restarts so a restarted loop
// RECONNECTS to the live in-memory session with NO `session/load` replay (the
// office-feed spam Layer A only quieted). GATED behind env AUTODEV_GROK_LEADER,
// DEFAULT OFF — when off, the existing non-leader ACP path (1.4.188/1.4.191) is
// used UNCHANGED.
//
// ARCHITECTURE (verified live on grok 1.0.41; see memory `grok-leader-always-open`
// + the 1.4.193 re-spike):
//   • A per-agent grok LEADER daemon (`grok agent --always-approve leader
//     --no-exit-on-disconnect --relay-on-demand --no-auto-update --leader-socket
//     <per-agent .sock>`) is a shared backend that survives client disconnects.
//   • CRITICAL grok-1.0.41 fact: the leader EVICTS a session's in-memory context
//     when its LAST client disconnects (the session persists on disk, but a fresh
//     client then gets "unknown session id" and must `session/load` = the replay).
//     So a bare leader is NOT enough for attach-without-load across a loop restart.
//   • Fix: a detached KEEPALIVE client holds the session warm in the leader's
//     memory forever. Loop clients then attach as a SECOND concurrent client and
//     `session/prompt {sessionId}` DIRECTLY — context intact, NO session/load —
//     across any number of loop-process restarts (proven: codeword recalled,
//     zero session/load).
//   • The ONE `session/load` (cold recovery from disk) happens inside the
//     keepalive at cold start when it is seeded with the persisted id; every
//     subsequent loop restart is a warm attach. No live keepalive ⇒ degrade to
//     Layer A (session/load), never data-loss.
//
// REAP BY PID (critical): `grok leader list/kill` CANNOT see a per-socket
// `--relay-on-demand` leader (verified: list→[], "No leader candidates found").
// So we track the leader + keepalive PIDs in `.autodev/leader.json` and reap the
// pid-trees ourselves. `autodev leader-stop <root>` (hidden) is what the app calls
// on office stop/remove/quit. The loop's own SIGINT/exit reaper kills ONLY the
// thin client (leader/keepalive are DETACHED, so they survive a loop restart).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { killProcessTree } from '../../core/killProcessTree';
import { getSessionId, saveSessionId, autodevDir } from '../../sessionState';
import type { ProviderId } from '../../providers';

// Re-export the keepalive runner + its options so existing importers keep working.
export { runKeepalive } from './keepalive';
export type { RunKeepaliveOpts } from './keepalive';

/** Shape persisted to `.autodev/leader.json` (the app contract). `pid` is the
 *  LEADER daemon pid; `keepalivePid` the detached session-holder. Both are reaped
 *  by `autodev leader-stop <root>`. `sessionId` is the warm grok session. */
export interface LeaderInfo {
  pid: number;
  socket: string;
  startedAt: string;
  keepalivePid?: number;
  sessionId?: string;
  root?: string;
}

/** Env gate — leader mode is OPT-IN and DEFAULT OFF. Pure (env injectable). */
export function leaderModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env['AUTODEV_GROK_LEADER'] ?? '').toLowerCase().trim();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Per-agent AF_UNIX socket. Prefer `.autodev/grok-leader.sock`; fall back to a
 *  hashed path under tmp when the workspace path would blow the ~108-byte sun_path
 *  limit (a deterministic function of the root either way). */
export function leaderSocketPath(root: string): string {
  const inAutodev = path.join(root, '.autodev', 'grok-leader.sock');
  if (Buffer.byteLength(inAutodev) <= 100) { return inAutodev; }
  const h = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `autodev-grok-${h}.sock`);
}

export function leaderJsonPath(root: string): string { return path.join(root, '.autodev', 'leader.json'); }
export function leaderSidPath(root: string): string { return path.join(root, '.autodev', 'grok-leader.sid'); }

export function readLeaderInfo(root: string): LeaderInfo | null {
  try {
    const raw = fs.readFileSync(leaderJsonPath(root), 'utf8');
    const info = JSON.parse(raw) as LeaderInfo;
    if (info && typeof info.pid === 'number' && typeof info.socket === 'string') { return info; }
  } catch { /* absent / malformed */ }
  return null;
}

export function writeLeaderInfo(root: string, info: LeaderInfo): void {
  try { autodevDir(root); fs.writeFileSync(leaderJsonPath(root), JSON.stringify(info, null, 2), 'utf8'); } catch { /* best effort */ }
}

export function removeLeaderInfo(root: string): void {
  try { fs.unlinkSync(leaderJsonPath(root)); } catch { /* already gone */ }
}

/** `process.kill(pid, 0)` liveness probe — true iff the pid exists (and is ours
 *  or EPERM, which still means alive). */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) { return false; }
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

/**
 * PURE orphan-sweep decision. Given the persisted info and the observed liveness
 * of its pieces, decide whether to reuse a still-live leader ('adopt'), reap a
 * stale/dead one ('reap-stale'), or spawn fresh ('spawn'). Unit-tested.
 */
export function decideLeaderAction(
  info: LeaderInfo | null,
  alive: { leader: boolean; keepalive: boolean; socket: boolean },
): 'spawn' | 'adopt' | 'reap-stale' {
  if (!info) { return 'spawn'; }
  const keepaliveOk = info.keepalivePid ? alive.keepalive : true;
  if (alive.leader && keepaliveOk && alive.socket) { return 'adopt'; }
  return 'reap-stale';
}

/** Is the persisted leader fully healthy right now (adoptable)? */
export function leaderHealthy(info: LeaderInfo | null): boolean {
  if (!info) { return false; }
  const alive = { leader: isPidAlive(info.pid), keepalive: isPidAlive(info.keepalivePid), socket: (() => { try { return fs.existsSync(info.socket); } catch { return false; } })() };
  return decideLeaderAction(info, alive) === 'adopt';
}

function readSidFile(sidFile: string): string | null {
  try { const s = fs.readFileSync(sidFile, 'utf8').trim(); return s || null; } catch { return null; }
}

async function waitUntil(pred: () => boolean, ms: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) { return true; } await new Promise((r) => setTimeout(r, stepMs)); }
  return pred();
}

function openLogFd(file: string): number | 'ignore' {
  try { return fs.openSync(file, 'a'); } catch { return 'ignore'; }
}

/** Resolve the minimal keepalive entry (out/providers/grok/keepaliveMain.js) so a
 *  detached keepalive loads with NO commander/CLI graph. Overridable for odd
 *  packagings via AUTODEV_KEEPALIVE_ENTRY. */
export function keepaliveEntryPath(): string {
  const override = process.env['AUTODEV_KEEPALIVE_ENTRY'];
  if (override && fs.existsSync(override)) { return override; }
  return path.join(__dirname, 'keepaliveMain.js');
}

/** Reap the leader + keepalive pid-trees named in `info` (best-effort). */
function reapLeaderProcs(info: LeaderInfo): void {
  if (info.keepalivePid) { try { killProcessTree(info.keepalivePid); } catch { /* ignore */ } }
  if (info.pid) { try { killProcessTree(info.pid); } catch { /* ignore */ } }
}

export interface EnsureLeaderOpts {
  root: string;
  bin: string;
  providerId: ProviderId;
  model?: string;
  log: (msg: string) => void;
}

/**
 * ORPHAN-SWEEP + ensure a live leader+keepalive for this root. Adopts a still-live
 * one (no second leader), reaps a stale/dead one, else spawns both DETACHED so they
 * survive the loop process exiting. Returns the LeaderInfo (with the warm session
 * id) or null when the backend could not be established (caller falls back to the
 * non-leader ACP path). Never throws.
 */
export async function ensureLeader(opts: EnsureLeaderOpts): Promise<LeaderInfo | null> {
  const { root, bin, providerId, model, log } = opts;
  const existing = readLeaderInfo(root);
  if (existing && leaderHealthy(existing)) {
    log(`grok leader: adopting live backend (leader=${existing.pid} keepalive=${existing.keepalivePid ?? '?'} sid=${(existing.sessionId ?? '').slice(0, 8)}…)`);
    return existing;
  }
  if (existing) {
    log(`grok leader: reaping stale backend (leader=${existing.pid} keepalive=${existing.keepalivePid ?? '?'})`);
    reapLeaderProcs(existing);
    removeLeaderInfo(existing.root ?? root);
  }

  const socket = leaderSocketPath(root);
  try { fs.unlinkSync(socket); } catch { /* no stale socket */ }
  autodevDir(root);

  // 1) Spawn the LEADER daemon, detached.
  const leaderArgs = ['agent', '--always-approve', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--no-auto-update', '--leader-socket', socket];
  const leaderErrFd = openLogFd(path.join(root, '.autodev', 'grok-leader.err'));
  let leaderChild: child_process.ChildProcess;
  try {
    leaderChild = child_process.spawn(bin, leaderArgs, {
      cwd: root, detached: true,
      stdio: ['ignore', 'ignore', leaderErrFd],
      env: { ...process.env, TERM: process.env['TERM'] || 'xterm-256color' },
    });
  } catch (err) { log(`grok leader: spawn failed (${(err as Error)?.message ?? err})`); return null; }
  leaderChild.unref();
  const leaderPid = leaderChild.pid;
  if (!leaderPid) { log('grok leader: no pid after spawn'); return null; }
  const sockOk = await waitUntil(() => { try { return fs.existsSync(socket); } catch { return false; } }, 15_000);
  if (!sockOk) { log('grok leader: socket never appeared — reaping'); try { killProcessTree(leaderPid); } catch { /* ignore */ } return null; }

  // 2) Spawn the KEEPALIVE client, detached — it holds the session warm. Seed it
  //    with the persisted id so a cold start does its ONE session/load here.
  const sidFile = leaderSidPath(root);
  try { fs.unlinkSync(sidFile); } catch { /* ignore */ }
  const seed = getSessionId(root, providerId) || undefined;
  const kaArgs = [keepaliveEntryPath(), '--socket', socket, '--cwd', root, '--sid-file', sidFile, '--bin', bin];
  if (seed) { kaArgs.push('--seed', seed); }
  let kaChild: child_process.ChildProcess;
  try {
    kaChild = child_process.spawn(process.execPath, kaArgs, {
      cwd: root, detached: true, stdio: 'ignore',
      // ELECTRON_RUN_AS_NODE so an Electron-bundled CLI runs the keepalive as pure
      // node (no window) — the inverse of the app's ELECTRON_RUN_AS_NODE trap.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERM: process.env['TERM'] || 'xterm-256color' },
    });
  } catch (err) { log(`grok leader: keepalive spawn failed (${(err as Error)?.message ?? err})`); try { killProcessTree(leaderPid); } catch { /* ignore */ } return null; }
  kaChild.unref();
  const keepalivePid = kaChild.pid;
  const gotSid = await waitUntil(() => readSidFile(sidFile) !== null, 25_000);
  const sessionId = readSidFile(sidFile) || undefined;
  if (!keepalivePid || !gotSid || !sessionId) {
    log('grok leader: keepalive failed to establish a session — reaping');
    if (keepalivePid) { try { killProcessTree(keepalivePid); } catch { /* ignore */ } }
    try { killProcessTree(leaderPid); } catch { /* ignore */ }
    return null;
  }

  const info: LeaderInfo = { pid: leaderPid, socket, startedAt: new Date().toISOString(), keepalivePid, sessionId, root };
  writeLeaderInfo(root, info);
  try { saveSessionId(root, providerId, sessionId); } catch { /* ignore */ }
  log(`grok leader: backend up (leader=${leaderPid} keepalive=${keepalivePid} sid=${sessionId.slice(0, 8)}…)`);
  return info;
}

/**
 * `autodev leader-stop <root>` — kill the leader + keepalive pid-trees named in
 * `.autodev/leader.json` and clean up the socket / sid / json. This is what the
 * app calls on office stop / remove / quit. Best-effort; returns whether anything
 * was reaped.
 */
export function stopLeader(root: string, log: (msg: string) => void): boolean {
  const info = readLeaderInfo(root);
  let killed = false;
  if (info) {
    if (info.keepalivePid && isPidAlive(info.keepalivePid)) { try { killProcessTree(info.keepalivePid); killed = true; } catch { /* ignore */ } }
    if (info.pid && isPidAlive(info.pid)) { try { killProcessTree(info.pid); killed = true; } catch { /* ignore */ } }
    try { if (info.socket) { fs.unlinkSync(info.socket); } } catch { /* ignore */ }
  }
  try { fs.unlinkSync(leaderSocketPath(root)); } catch { /* ignore */ }
  try { fs.unlinkSync(leaderSidPath(root)); } catch { /* ignore */ }
  removeLeaderInfo(root);
  log(killed ? `leader-stop: reaped grok leader backend for ${root}` : `leader-stop: no live grok leader for ${root}`);
  return killed;
}
