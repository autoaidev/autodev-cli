// ---------------------------------------------------------------------------
// TodoTaskVerifier — verify-and-re-append backstop for WS-pushed tasks.
//
// THE BUG IT FIXES
//   A task pushed over the WS (the `user_message` A2A frame) used to be appended
//   to TODO.md immediately and ACKed (task_ack → the office stamps delivered_at
//   and permanently drops the task from its 45s redelivery sweep) in the same
//   breath. A grok-acp agent, however, REWRITES TODO.md during its own turn
//   (taskLoop.ts clobber — see pendingSteers.ts header), so the just-appended
//   line is wiped: the task was acked-as-delivered, written, overwritten, and
//   never re-pushed. Steers survive this via the durable-steer queue; tasks had
//   no such protection.
//
// THE FIX (this module is the backbone)
//   • track(id, payload, dbTaskId) registers a delivered task.
//   • A poller tick (~10s) reads which task ids are currently in TODO.md:
//       – ABSENT  → (re-)append it idempotently-by-id (a grok clobber is
//                   repaired on the next tick), and reset its confirmation count.
//       – PRESENT → increment a consecutive-present counter; once it has been
//                   present for `confirmTicks` ticks in a row the task is
//                   DURABLE: send the deferred task_ack and stop tracking it.
//       – DONE    → the agent finished it; stop tracking immediately and never
//                   re-append (prevents resurrecting a completed/pruned task).
//   • The ack is DEFERRED until durable-present, so the office's 45s sweep stays
//     armed as a backstop: if the CLI dies before the line is durable, the
//     office re-pushes it.
//
// Re-append idempotency is guaranteed by the injected appendIfAbsent (the
// presence check + append run inside TodoWriteManager's per-file queue), so no
// duplicate line is ever produced even under a concurrent write.
//
// This is deliberately a small, side-effect-injected unit (no socket, no fs of
// its own) so it is directly unit-testable — see test/todoTaskVerifier.smoke.mjs.
// ---------------------------------------------------------------------------

export interface TodoState {
  /** Ids present in TODO.md as an open task ([ ] todo or [~] in-progress). */
  present: Set<string>;
  /** Ids present in TODO.md as a completed task ([x] done). */
  done: Set<string>;
}

interface TrackedTask {
  id: string;
  payload: string;
  /** Office DB task id to ack once durable. Absent on very old server frames. */
  dbTaskId?: string;
  /** Consecutive ticks the id has been seen present. Resets to 0 on a clobber. */
  presentTicks: number;
}

export interface TodoTaskVerifierOptions {
  /** Poll interval. Default 10s ("poll every 10s until written, then stop"). */
  intervalMs?: number;
  /** Consecutive present ticks required before a task is considered durable. */
  confirmTicks?: number;
  /** Read the current TODO.md task ids, split by status. Must not throw fatally. */
  readState: () => TodoState;
  /** Idempotent-by-id (re-)append of a clobbered/missing task. */
  appendIfAbsent: (id: string, payload: string) => Promise<void>;
  /** Send the deferred task_ack once the task is confirmed durably present. */
  sendAck: (dbTaskId: string) => void;
  /** Fired after a re-append so callers can nudge the loop (optional). */
  onReappended?: () => void;
  log?: (msg: string) => void;
}

export class TodoTaskVerifier {
  private readonly _tasks = new Map<string, TrackedTask>();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _intervalMs: number;
  private readonly _confirmTicks: number;

  constructor(private readonly _opts: TodoTaskVerifierOptions) {
    this._intervalMs = _opts.intervalMs ?? 10_000;
    this._confirmTicks = Math.max(1, _opts.confirmTicks ?? 2);
  }

  /** Is this task id currently being tracked (not yet confirmed durable)? */
  has(id: string): boolean { return this._tasks.has(id); }

  /** Number of tasks awaiting durable confirmation. */
  get size(): number { return this._tasks.size; }

  /**
   * Register a delivered task for verification. Idempotent by id — re-tracking
   * the same id (e.g. the office re-pushed the same DB task under a new delivery
   * id) refreshes the payload/dbTaskId without resetting its progress. Starts
   * the poller if it was idle.
   */
  track(id: string, payload: string, dbTaskId?: string): void {
    const existing = this._tasks.get(id);
    if (existing) {
      existing.payload = payload;
      if (dbTaskId) { existing.dbTaskId = dbTaskId; }
    } else {
      this._tasks.set(id, { id, payload, dbTaskId, presentTicks: 0 });
    }
    this._ensureTimer();
  }

  /** Stop tracking a task (e.g. it was cancelled/removed upstream). */
  forget(id: string): void {
    this._tasks.delete(id);
    if (this._tasks.size === 0) { this._stopTimer(); }
  }

  /**
   * One verification pass. Public so tests can drive it deterministically; the
   * timer simply calls it on an interval.
   */
  tick(): void {
    if (this._tasks.size === 0) { this._stopTimer(); return; }
    let state: TodoState;
    try { state = this._opts.readState(); }
    catch (err) { this._log(`todo verify: read failed, retrying next tick: ${err}`); return; }

    for (const [id, task] of [...this._tasks]) {
      if (state.done.has(id)) {
        // The agent completed it. The office no longer needs our redelivery
        // backstop; ack so it un-fades, then stop tracking (never re-append).
        if (task.dbTaskId) { this._opts.sendAck(task.dbTaskId); }
        this._tasks.delete(id);
        continue;
      }
      if (state.present.has(id)) {
        task.presentTicks++;
        if (task.presentTicks >= this._confirmTicks) {
          // Durably present → NOW send the deferred ack and stop polling it.
          if (task.dbTaskId) { this._opts.sendAck(task.dbTaskId); }
          this._tasks.delete(id);
        }
      } else {
        // Clobbered (or never landed) → repair idempotently and restart the
        // confirmation count. appendIfAbsent guarantees no duplicate line.
        task.presentTicks = 0;
        void this._opts.appendIfAbsent(id, task.payload)
          .then(() => { this._opts.onReappended?.(); })
          .catch(err => this._log(`todo verify: re-append of ${id} failed: ${err}`));
      }
    }
    if (this._tasks.size === 0) { this._stopTimer(); }
  }

  /** Stop the poller and clear all tracked tasks (loop teardown). */
  stop(): void {
    this._stopTimer();
    this._tasks.clear();
  }

  private _ensureTimer(): void {
    if (this._timer || this._tasks.size === 0) { return; }
    this._timer = setInterval(() => this.tick(), this._intervalMs);
    // Don't keep the process alive just for this verification timer.
    (this._timer as unknown as { unref?: () => void }).unref?.();
  }

  private _stopTimer(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  private _log(msg: string): void { this._opts.log?.(msg); }
}
