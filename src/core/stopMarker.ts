import * as fs from 'fs';
import * as path from 'path';

/**
 * A user-requested "stay stopped" marker for a workspace.
 *
 * When the desktop app (or a user) STOPS an agent, we must guarantee it stays
 * stopped — but an `autodev office <slug>` supervisor re-lists the roster every
 * ~15s and auto-respawns any character that is offline, which silently brought a
 * stopped agent back to life. This marker is the shared signal that closes that
 * gap: while `.autodev/stopped` exists, the supervisor MUST NOT (re)spawn a loop
 * for the workspace. It is written by the desktop app's Stop and cleared by an
 * EXPLICIT start (`autodev start`, or the app's Start), so a stopped agent comes
 * back only when the user asks for it.
 *
 * A dedicated file — not a `.autodev/settings.json` field — so writing it never
 * races the loop's concurrent settings/TODO rewrites.
 */
export function stopMarkerPath(cwd: string): string {
  return path.join(cwd, '.autodev', 'stopped');
}

export function isUserStopped(cwd: string): boolean {
  try {
    return fs.existsSync(stopMarkerPath(cwd));
  } catch {
    return false;
  }
}

export function markUserStopped(cwd: string, reason = ''): void {
  try {
    const p = stopMarkerPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ stoppedAt: new Date().toISOString(), reason }) + '\n', 'utf8');
  } catch {
    /* best effort — a missing marker only means the supervisor may respawn */
  }
}

export function clearUserStopped(cwd: string): void {
  try {
    fs.rmSync(stopMarkerPath(cwd), { force: true });
  } catch {
    /* best effort */
  }
}
