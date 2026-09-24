// Pure status classifier + controller for the `mcp-operate` hook-forwarding
// status heuristic. Extracted from commands/mcpOperate.ts so the behaviour
// "report working after a WORKING_HOOK, report idle immediately on a turn-END
// hook (Stop/session_end/…) and on any bridge teardown" is unit-testable
// WITHOUT the presence socket / HTTP proxy. The controller is the real logic
// the bridge runs; the bridge only injects the side effect (post set_status).

export type OperateStatus = 'working' | 'idle';

// Hook names that mean the driven session is actively doing work.
export const WORKING_HOOKS = new Set<string>([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification',
]);

// Hook names that mean the turn/session ENDED — flip to idle NOW instead of
// waiting out the inactivity timer. Both the raw provider spellings
// (Stop / StopFailure / SessionEnd) and the ProviderNormalizer-normalized forms
// (session_end / stop_failure) are accepted, because the forwarded hook may
// carry either spelling depending on the path it took.
export const TURN_END_HOOKS = new Set<string>([
  'Stop', 'StopFailure', 'SessionEnd', 'session_end', 'stop_failure',
]);

export type HookKind = 'working' | 'end' | null;

/** Classify a hook name: work-in-progress, turn-ended, or neither/ignore. */
export function classifyHook(name: string | undefined | null): HookKind {
  if (!name) { return null; }
  if (TURN_END_HOOKS.has(name)) { return 'end'; }
  if (WORKING_HOOKS.has(name)) { return 'working'; }
  return null;
}

export interface OperateStatusController {
  /** Report a raw status transition (deduped: an unchanged status is a no-op). */
  reportStatus(status: OperateStatus): void;
  /** A WORKING_HOOK was seen → report 'working' and (re)arm the inactivity→idle timer. */
  markWorking(): void;
  /** A turn-END hook was seen → cancel the idle timer and flip to 'idle' immediately. */
  markTurnEnd(): void;
  /** Any bridge teardown path → best-effort single 'idle' so a session never lingers 'working'. */
  reportIdleOnTeardown(): void;
  /** The current deduped status (test/inspection hook). */
  getReported(): OperateStatus | null;
}

export interface OperateStatusOptions {
  /** Inactivity window before an untouched 'working' decays to 'idle' (default 120s). */
  idleAfterMs?: number;
  /** Timer factory — overridable so a test can drive it synchronously. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const DEFAULT_IDLE_AFTER_MS = 120_000;

/**
 * Build the status state-machine the hook forwarder runs. `report` is the only
 * side effect (post a set_status to the office); everything else is pure timer
 * bookkeeping, so a test injects a fake timer and drives transitions
 * synchronously. Dedup + timer semantics match the previous inline code exactly.
 */
export function createOperateStatusController(
  report: (status: OperateStatus) => void,
  opts: OperateStatusOptions = {},
): OperateStatusController {
  const idleAfterMs = opts.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const setTimer = opts.setTimer
    ?? ((fn: () => void, ms: number): unknown => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? ((t: unknown): void => { clearTimeout(t as ReturnType<typeof setTimeout>); });

  let reportedStatus: OperateStatus | null = null;
  let idleTimer: unknown = null;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) { clearTimer(idleTimer); idleTimer = null; }
  };

  const reportStatus = (status: OperateStatus): void => {
    if (reportedStatus === status) { return; }   // dedupe — the office no-ops an unchanged status
    reportedStatus = status;
    report(status);
  };

  const markWorking = (): void => {
    reportStatus('working');
    clearIdleTimer();
    idleTimer = setTimer(() => { idleTimer = null; reportStatus('idle'); }, idleAfterMs);
  };

  const markTurnEnd = (): void => {
    clearIdleTimer();
    reportStatus('idle');
  };

  const reportIdleOnTeardown = (): void => {
    // Best-effort — a teardown path must never be blocked or thrown out of by
    // status IO. The reportStatus dedupe guards against a double 'idle'.
    try { clearIdleTimer(); reportStatus('idle'); } catch { /* ignore */ }
  };

  return {
    reportStatus, markWorking, markTurnEnd, reportIdleOnTeardown,
    getReported: (): OperateStatus | null => reportedStatus,
  };
}
