// ---------------------------------------------------------------------------
// killProcessTree — cross-platform, best-effort process-tree termination.
//
// The problem: `child.kill('SIGKILL')` (and `process.kill(pid)`) only ever
// targets the PARENT process. When that parent has spawned its own children —
// e.g. grok headless spawns node / tool subprocesses — those descendants are
// re-parented to init/PID 1 and keep running (burning tokens, holding ports,
// looking "stuck"). On Windows this is worse: nothing reaps grok's tree at all,
// so "Stop all" leaves grok.exe + children orphaned.
//
// This util reaps the WHOLE tree on every platform:
//   • win32:        `taskkill /PID <pid> /T /F` — /T kills the tree, /F forces,
//                   no admin needed for your own processes.
//   • linux:        walk /proc to collect every transitive descendant, SIGKILL
//                   each descendant first (before the parent, so nothing gets
//                   re-parented and saved), then kill the process GROUP (for
//                   detached children) and finally the pid itself.
//   • darwin/other: kill the process GROUP (detached children) + the pid.
//
// Every syscall is wrapped in try/catch: this function is best-effort and MUST
// NEVER throw — callers invoke it from teardown/signal paths.
// ---------------------------------------------------------------------------

import * as child_process from 'child_process';
import * as fs from 'fs';

/**
 * Build the `taskkill` argv used on win32. Pulled out as a pure function so it
 * can be unit-tested without actually being on Windows.
 */
export function taskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * Collect every transitive descendant pid of `pid` by walking /proc (Linux
 * only). Best-effort: returns [] if /proc is unavailable or unreadable.
 */
function collectDescendantsProc(pid: number): number[] {
  const out: number[] = [];
  try {
    // parent pid -> [child pids], built from a single /proc snapshot.
    const childrenByParent = new Map<number, number[]>();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) { continue; }
      const p = Number(name);
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        // The comm (field 2) is wrapped in parens and may itself contain spaces
        // or ')'. Everything after the LAST ')' is space-delimited and stable:
        //   <state> <ppid> <pgrp> ...
        const rparen = stat.lastIndexOf(')');
        if (rparen < 0) { continue; }
        const rest = stat.slice(rparen + 2).split(' ');
        const ppid = Number(rest[1]);
        if (!Number.isFinite(ppid)) { continue; }
        const arr = childrenByParent.get(ppid);
        if (arr) { arr.push(p); } else { childrenByParent.set(ppid, [p]); }
      } catch { /* process vanished mid-scan */ }
    }
    const stack = [pid];
    const seen = new Set<number>();
    while (stack.length) {
      const cur = stack.pop() as number;
      for (const c of childrenByParent.get(cur) ?? []) {
        if (seen.has(c)) { continue; }
        seen.add(c);
        out.push(c);
        stack.push(c);
      }
    }
  } catch { /* /proc unavailable (e.g. darwin) */ }
  return out;
}

/**
 * Force-kill an entire process tree rooted at `pid`, cross-platform.
 * Best-effort and never throws. Default signal is SIGKILL.
 */
export function killProcessTree(pid: number, opts?: { signal?: NodeJS.Signals }): void {
  const signal = opts?.signal ?? 'SIGKILL';
  if (!Number.isInteger(pid) || pid <= 1) { return; }

  if (process.platform === 'win32') {
    try {
      child_process.spawnSync('taskkill', taskkillArgs(pid), { stdio: 'ignore', windowsHide: true });
    } catch { /* best effort */ }
    return;
  }

  // POSIX. Kill descendants FIRST so a killed parent can't re-parent live
  // children to init before we reach them (that is the orphan bug).
  if (process.platform === 'linux') {
    for (const d of collectDescendantsProc(pid)) {
      try { process.kill(d, signal); } catch { /* already gone */ }
    }
  }
  // Kill the process GROUP if the child was spawned detached (its own group
  // leader). Harmless no-op / EPERM otherwise.
  try { process.kill(-pid, signal); } catch { /* not a group leader or gone */ }
  // Finally the pid itself.
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/** Convenience: reap several process trees, best-effort. */
export function killProcessTreeByPids(pids: number[]): void {
  for (const pid of pids) {
    try { killProcessTree(pid); } catch { /* best effort */ }
  }
}
