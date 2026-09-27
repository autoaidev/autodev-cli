import * as path from 'path';
import { Command } from 'commander';
import { stopLeader } from '../providers/grok/leader';
import { log } from '../logger';

/**
 * `autodev leader-stop <root>` — hidden. Reap the grok LEADER + keepalive
 * pid-trees recorded in `<root>/.autodev/leader.json` and clean up the socket /
 * sid / json. This is what the desktop app / office supervisor calls on office
 * STOP / REMOVE / QUIT (the leader is DETACHED so it outlives loop restarts;
 * `grok leader kill` cannot see a per-socket relay-on-demand leader, so we reap by
 * pid). Best-effort; always exits 0.
 */
export function leaderStopCommand(program: Command): void {
  program
    .command('leader-stop <root>', { hidden: true })
    .description('Reap the grok leader backend for a workspace root (pid-tree reap + cleanup)')
    .action((rootArg: string) => {
      const root = path.resolve(rootArg);
      try { stopLeader(root, (m) => log.info(m)); } catch (err) { log.error(`leader-stop: ${(err as Error)?.message ?? err}`); }
      process.exit(0);
    });
}
