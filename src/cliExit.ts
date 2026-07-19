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
//   - 'give_up'     — CLI exited again after reminder, but the turn genuinely
//                     RAN (produced output / clean idle) and the model merely
//                     forgot to tick the box; auto-mark [x] and move on
//   - 'hard_fail'   — the PROVIDER hard-failed and produced no real work this
//                     cycle (reauth/session error/watchdog-no-output/crash/…);
//                     do NOT mark done — flag the task as failed/blocked so an
//                     outage is honest, not a false green
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
  | { kind: 'give_up' }
  | { kind: 'hard_fail'; reason: string };

/**
 * Process-level signals captured by the caller at CLI-exit time, used to tell
 * a provider hard-failure apart from a ran-but-unmarked completion.
 */
export interface CliExitContext {
  /** The CLI process exited non-zero — the provider's real failure surface. */
  exitedNonZero?: boolean;
  /**
   * The provider wrote an error sentinel to its stdout capture this turn even
   * though it exited 0 (opencode SDK appends `[ERROR] …` on session.error and
   * then still writes exit-code 0). Carries a short reason label when set.
   */
  stdoutError?: string | null;
}

/**
 * SessionEnd `reason` values (and the copilot/opencode equivalents) that mean
 * the provider itself failed — as opposed to 'idle'/'completed' which mean the
 * turn genuinely finished. Grok writes these on non-zero finishes; opencode's
 * hooks plugin maps session.error → StopFailure (handled separately below).
 */
const FAIL_REASONS = new Set<string>([
  'reauth_required', 'startup-exit', 'session-exit', 'launch-failed',
  'watchdog', 'error', 'session.error',
]);

/**
 * Hook events that prove the turn actually produced work this cycle. Their
 * presence downgrades an ambiguous signal (a watchdog kill) from a provider
 * outage to a ran-but-unmarked completion.
 */
const WORK_EVENTS = new Set<string>([
  'AgentMessage', 'PostToolUse', 'PreToolUse', 'Notification',
  'Reasoning', 'StepEnded', 'Stop',
]);

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
  decide(ctx: CliExitContext = {}): CliExitDecision {
    if (this.isTaskDone()) { return { kind: 'done' }; }

    // A provider hard-failure that produced no real work is NEVER a completion,
    // whatever the TODO marker looks like. Check it before the [~]/give_up
    // branches so an outage that left a stray [~] (or no mark at all) is
    // reported as failed/blocked instead of being auto-marked [x] (false green).
    const hardFail = this.findHardFailure(ctx);

    // If the agent marked [~] after we already sent a reminder, treat it as
    // give_up so the caller auto-marks [x] — avoids an infinite loop where
    // the agent keeps marking [~] and exiting on every retry.
    if (this.taskIsInProgress()) {
      if (hardFail) { return { kind: 'hard_fail', reason: hardFail }; }
      if (this.reminderSent) { return { kind: 'give_up' }; }
      return { kind: 'deferred' };
    }

    const rl = this.findRecentRateLimit();
    if (rl) { return { kind: 'rate_limit', error: rl }; }

    if (hardFail) { return { kind: 'hard_fail', reason: hardFail }; }

    if (this.reminderSent) { return { kind: 'give_up' }; }
    this.reminderSent = true;
    return { kind: 'remind' };
  }

  /**
   * Decide whether THIS exit was a provider hard-failure that produced no real
   * work — as opposed to a turn that ran fine and merely left the box unticked.
   * Returns a short reason label on a hard-failure, else null.
   *
   * Signals (any one is sufficient):
   *   - a recent SessionEnd whose `reason` is a provider-failure reason
   *   - a recent StopFailure hook (grok/opencode failed turn)
   *   - a recent `reauth_required` hook (token/OAuth gate)
   *   - the provider wrote an [ERROR] sentinel to stdout but still exited 0
   *     (opencode SDK session.error / "No model available")
   *   - a non-zero process exit with NO assistant work this cycle (crash /
   *     launch-failed / copilot free-plan "No model available")
   *
   * A `watchdog` kill is treated as a hard-failure ONLY when the turn produced
   * no work — a watchdog that fired after real output is a ran-but-unmarked
   * turn (partial progress), which stays on the auto-mark path.
   */
  private findHardFailure(ctx: CliExitContext): string | null {
    const { failReason, sawWork } = this.scanHooksForFailure();
    if (failReason) {
      if (failReason === 'watchdog' && sawWork) { return null; }
      return failReason;
    }
    // No hook-based signal — fall back to the process-level signals the caller
    // captured. opencode SDK session.error exits 0, so its only tell is stdout.
    if (ctx.stdoutError) { return ctx.stdoutError; }
    // A non-zero exit with no work this turn = the provider died before doing
    // anything (crash / launch failure / model unavailable). A non-zero exit
    // that DID produce work is left to the reminder/give_up path unchanged.
    if (ctx.exitedNonZero && !sawWork) { return 'exit_nonzero'; }
    return null;
  }

  /**
   * Scan the recent hook-events tail (events after this task started) for a
   * provider-failure signal and whether any assistant work happened this turn.
   * Mirrors findRecentRateLimit()'s read strategy.
   */
  private scanHooksForFailure(): { failReason: string | null; sawWork: boolean } {
    let failReason: string | null = null;
    let sawWork = false;
    try {
      const hooksJsonl = path.join(this.workspaceRoot, '.autodev', 'hooks-events.jsonl');
      if (!fs.existsSync(hooksJsonl)) { return { failReason, sawWork }; }
      const stat = fs.statSync(hooksJsonl);
      const readFrom = Math.max(0, stat.size - 64 * 1024);
      const fd = fs.openSync(hooksJsonl, 'r');
      const buf = Buffer.alloc(stat.size - readFrom);
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      // Newest → oldest. Grok emits StopFailure THEN a more specific
      // SessionEnd(reason); scanning backwards we hit the specific reason first
      // and keep it (the `failReason` guard skips the older StopFailure).
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev: any;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        const ts = ev?.timestamp ? Date.parse(ev.timestamp) : NaN;
        if (Number.isFinite(ts) && ts < this.taskStartTime) { break; }
        const name = String(ev?.hook_event_name ?? '');
        if (WORK_EVENTS.has(name)) { sawWork = true; continue; }
        if (failReason) { continue; }
        if (name === 'reauth_required') { failReason = 'reauth_required'; continue; }
        if (name === 'SessionEnd') {
          const r = String(ev?.reason ?? '').trim();
          if (FAIL_REASONS.has(r)) { failReason = r; }
          continue;
        }
        if (name === 'StopFailure') { failReason = 'stop_failure'; continue; }
      }
    } catch { /* ignore */ }
    return { failReason, sawWork };
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
