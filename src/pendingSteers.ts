// ---------------------------------------------------------------------------
// Durable steer queue — `.autodev/pending-steers.jsonl`.
//
// A mid-run STEER delivered to a persistent ACP process (grok / opencode) used to
// be acked (marked seen server-side) the MOMENT it was handed to the process. If
// the loop/session restarted BEFORE that steered turn actually ran, the steer was
// silently LOST (the office had already stopped re-delivering it). This queue makes
// steers survive a restart with AT-LEAST-ONCE delivery:
//
//   • A steer is APPENDED here BEFORE it is acked.
//   • The server ack (onDelivered) + local removal fire only AFTER the steered turn
//     COMPLETES — never merely on hand-off to the process.
//   • On (re)start the loop DRAINS this file, re-delivering each queued steer to the
//     live AcpSession as a loop-tracked turn, removing it only on completion.
//   • Dedup is by `id` (the A2A delivery id): a server reconnect-replay of a still-
//     queued steer, or one already completed, is a no-op.
//
// Deliberately NOT TODO.md: grok rewrites TODO.md mid-turn (taskLoop.ts:1212-1218)
// and would clobber an appended steer. This is a separate, append-only journal.
//
// One loop process owns a given root, so plain sync fs (append + rewrite) is safe;
// malformed / partially-written lines are skipped on read so a torn append (a kill
// mid-write) never poisons the queue.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

export interface PendingSteer {
  /** A2A delivery id — the dedup key (a reconnect-replay carries the same id). */
  id: string;
  /** The steer text (already trimmed / attachment-folded by the caller). */
  text: string;
  /** Enqueue time (ms since epoch). */
  ts: number;
}

export const PENDING_STEERS_FILE = '.autodev/pending-steers.jsonl';

function filePath(root: string): string {
  return path.join(root, PENDING_STEERS_FILE);
}

/**
 * Read + parse the queue, deduped by id (last write wins), skipping any malformed
 * / partially-written lines. Returns [] when the file is absent. PURE read.
 */
export function readPendingSteers(root: string): PendingSteer[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath(root), 'utf8'); }
  catch { return []; }
  const byId = new Map<string, PendingSteer>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) { continue; }
    let obj: unknown;
    try { obj = JSON.parse(t); } catch { continue; } // torn / bad line → skip
    const o = obj as Partial<PendingSteer>;
    if (!o || typeof o.id !== 'string' || typeof o.text !== 'string') { continue; }
    byId.set(o.id, { id: o.id, text: o.text, ts: typeof o.ts === 'number' ? o.ts : Date.now() });
  }
  // Preserve first-seen order (Map keeps insertion order; last-value wins but the
  // key's position is its first insertion, which is the delivery order we want).
  return [...byId.values()];
}

/** True if a steer with this id is already queued. */
export function hasPendingSteer(root: string, id: string): boolean {
  return readPendingSteers(root).some((s) => s.id === id);
}

/**
 * Append a steer to the queue unless one with the same id is already present
 * (dedup). Returns true if it was newly enqueued, false if it was a duplicate
 * (or could not be written). Best-effort; a write failure is swallowed.
 */
export function enqueuePendingSteer(root: string, steer: PendingSteer): boolean {
  if (hasPendingSteer(root, steer.id)) { return false; }
  try {
    fs.mkdirSync(path.dirname(filePath(root)), { recursive: true });
    fs.appendFileSync(filePath(root), JSON.stringify(steer) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the steer with this id from the queue by rewriting the file without it.
 * Best-effort. When the queue becomes empty the file is left as an empty file
 * (readPendingSteers treats it as []).
 */
export function removePendingSteer(root: string, id: string): void {
  const remaining = readPendingSteers(root).filter((s) => s.id !== id);
  try {
    if (remaining.length === 0) {
      fs.writeFileSync(filePath(root), '', 'utf8');
    } else {
      fs.writeFileSync(filePath(root), remaining.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
    }
  } catch { /* ignore */ }
}
