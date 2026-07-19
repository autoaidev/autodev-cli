import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// presenceGuard — decide whether a workspace already has a live `autodev start`
// loop, so a second `autodev start` can bail out instead of opening a competing
// WS. The running loop drops .autodev/ws-presence.lock ({pid, slug, ts}) once its
// WS connects and refreshes ts every heartbeat (see webSocketPoller). Two loops
// for the same workspace bind the same office slug and evict each other on the
// server's last-wins index every ~5s (a WebSocket eviction flap); this guard
// prevents the duplicate at startup.
// ---------------------------------------------------------------------------

export interface PresenceLock { pid?: number; slug?: string; ts?: number }

/** Path to the loop's live-presence lock for a workspace. */
export function presenceLockPath(cwd: string): string {
  return path.join(cwd, '.autodev', 'ws-presence.lock');
}

/** Read + parse the presence lock; null on absent / unreadable / bad JSON. */
export function readPresenceLock(cwd: string): PresenceLock | null {
  try {
    return JSON.parse(fs.readFileSync(presenceLockPath(cwd), 'utf8')) as PresenceLock;
  } catch { return null; }
}

/** True if pid is a live process OTHER than self. process.kill(pid,0) throwing
 *  ESRCH ⇒ dead; EPERM ⇒ exists but owned by another user (still alive). */
function defaultPidAlive(pid: number, selfPid: number): boolean {
  if (!pid || pid === selfPid) { return false; }
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface ForeignOwnerOpts {
  now?: number;
  selfPid?: number;
  freshMs?: number;
  isAlive?: (pid: number, selfPid: number) => boolean;
}

/**
 * Given a parsed ws-presence.lock, return the pid of a DIFFERENT, still-alive
 * loop that currently owns this workspace's live presence — or null when the
 * caller should proceed (no lock, our own pid, a dead pid, or a stale ts).
 * Freshness defaults to 90s (the loop refreshes ts every ~25s heartbeat, so this
 * tolerates a few missed beats while still ignoring a crashed loop's stale lock).
 */
export function foreignLoopOwner(lock: PresenceLock | null | undefined, opts: ForeignOwnerOpts = {}): number | null {
  if (!lock) { return null; }
  const now = opts.now ?? Date.now();
  const selfPid = opts.selfPid ?? process.pid;
  const freshMs = opts.freshMs ?? 90_000;
  const alive = opts.isAlive ?? defaultPidAlive;
  const pid = typeof lock.pid === 'number' ? lock.pid : 0;
  const ts = typeof lock.ts === 'number' ? lock.ts : 0;
  if (pid <= 0 || pid === selfPid) { return null; } // no/own pid → not a foreign owner
  if (now - ts >= freshMs) { return null; }         // stale lock → crashed/gone owner
  if (!alive(pid, selfPid)) { return null; }        // dead pid → free to take over
  return pid;
}
