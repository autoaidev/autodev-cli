import { Command } from 'commander';
import { killProcessTree } from '../core/killProcessTree';
import { log } from '../logger';

/**
 * `autodev kill-tree <pid>` — hidden utility. Force-kills an entire process
 * tree cross-platform (used by the desktop app to reap an interactive
 * "Connect & operate" grok it spawned via its own PTY, which the CLI's own
 * teardown can't reach). Best-effort; always exits 0 for a valid pid.
 */
export function killTreeCommand(program: Command): void {
  program
    .command('kill-tree <pid>', { hidden: true })
    .description('Force-kill a process tree by pid (cross-platform, best-effort)')
    .action((pidArg: string) => {
      const pid = Number(pidArg);
      if (!Number.isInteger(pid) || pid <= 1) {
        log.error(`kill-tree: refusing invalid pid "${pidArg}" (must be an integer > 1)`);
        process.exit(2);
      }
      killProcessTree(pid);
      process.exit(0);
    });
}
