// ---------------------------------------------------------------------------
// CliExitHandler — central decision logic for "the CLI process just ended,
// what should the loop do?". Replaces the tangle of inline branches that
// used to live in taskLoop.ts onCliExit().
//
// Inputs (read each call):
//   - TODO.md state for the current task line ([x] / [~] / [ ])
//   - .autodev/hooks-events.jsonl tail (StopFailure + SessionEnd events)
//
// Outputs (CliExitDecision):
//   - 'done'        — task already marked [x], resolve and move on
//   - 'deferred'    — task is [~], the AI deferred it; resolve and move on
//   - 'rate_limit'  — Claude was throttled; raise RateLimitError to pause loop
//   - 'remind'      — first exit without completion; send TODO.md reminder
//   - 'give_up'     — CLI exited again after reminder; resolve, move on
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { Task, parseTodo } from './todo';
import { RateLimitDetector, RateLimitError } from './rateLimit';

export type CliExitDecision =
  | { kind: 'done' }
  | { kind: 'deferred' }
  | { kind: 'rate_limit'; error: RateLimitError }
  | { kind: 'remind' }
  | { kind: 'give_up' };

export class CliExitHandler {
  private reminderSent = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly todoPath: string,
    private readonly task: Task,
    private readonly taskStartTime: number,
    private readonly isTaskDone: () => boolean,
  ) {}

  /** Run the decision tree. Stateless except for the one-shot reminder flag. */
  decide(): CliExitDecision {
    if (this.isTaskDone()) { return { kind: 'done' }; }

    // If the agent marked [~] after we already sent a reminder, treat it as
    // give_up so the caller auto-marks [x] — avoids an infinite loop where
    // the agent keeps marking [~] and exiting on every retry.
    if (this.taskIsInProgress()) {
      if (this.reminderSent) { return { kind: 'give_up' }; }
      return { kind: 'deferred' };
    }

    const rl = this.findRecentRateLimit();
    if (rl) { return { kind: 'rate_limit', error: rl }; }

    if (this.reminderSent) { return { kind: 'give_up' }; }
    this.reminderSent = true;
    return { kind: 'remind' };
  }

  /** Has the AI moved the task to [~]? */
  private taskIsInProgress(): boolean {
    try {
      const updated = parseTodo(this.todoPath);
      const byId           = this.task.id ? updated.find(t => t.id === this.task.id) : undefined;
      const byLine         = updated.find(t => t.line === this.task.line);
      const byLineVerified = (byLine && byLine.text === this.task.text) ? byLine : undefined;
      const byText         = updated.find(t => t.text === this.task.text);
      const match          = byId ?? byLineVerified ?? byText;
      return match?.status === 'in-progress';
    } catch { return false; }
  }

  /**
   * Scan recent hook events (StopFailure / SessionEnd) for a rate-limit
   * signal that arrived AFTER this task started. Returns null when none.
   * Looks at both `error: "rate_limit"` and `last_assistant_message` text
   * — Claude surfaces throttles through both channels at different times.
   */
  private findRecentRateLimit(): RateLimitError | null {
    try {
      const hooksJsonl = path.join(this.workspaceRoot, '.autodev', 'hooks-events.jsonl');
      if (!fs.existsSync(hooksJsonl)) { return null; }
      const stat = fs.statSync(hooksJsonl);
      const readFrom = Math.max(0, stat.size - 64 * 1024);
      const fd = fs.openSync(hooksJsonl, 'r');
      const buf = Buffer.alloc(stat.size - readFrom);
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev: any;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        const evt = ev?.hook_event_name;
        if (evt !== 'StopFailure' && evt !== 'SessionEnd') { continue; }
        const ts = ev?.timestamp ? Date.parse(ev.timestamp) : NaN;
        if (Number.isFinite(ts) && ts < this.taskStartTime) { break; }
        const errStr = String(ev?.error ?? '').toLowerCase();
        const lastMsg = String(ev?.last_assistant_message ?? '');
        if (errStr === 'rate_limit' || RateLimitDetector.matches(lastMsg)) {
          return RateLimitDetector.toError(lastMsg);
        }
        // Don't break — SessionEnd often follows StopFailure, the rate-limit
        // signal is on the StopFailure record one line earlier.
      }
    } catch { /* ignore */ }
    return null;
  }
}
