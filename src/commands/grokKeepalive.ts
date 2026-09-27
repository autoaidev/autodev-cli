import { Command } from 'commander';
import { runKeepalive } from '../providers/grok/leader';

/**
 * `autodev grok-keepalive` — hidden. The detached session-holder for the grok
 * LEADER backend (Layer B). Connects to the leader as a client, establishes ONE
 * session (session/load the seed id, else session/new), writes the id to
 * `--sid-file`, then HOLDS the connection open forever so the leader never evicts
 * the in-memory context — the key that makes attach-without-load survive loop
 * restarts. Spawned detached by `ensureLeader`; not meant to be run by hand.
 */
export function grokKeepaliveCommand(program: Command): void {
  program
    .command('grok-keepalive', { hidden: true })
    .description('Hold a grok leader session warm (internal; spawned detached by the loop)')
    .requiredOption('--socket <path>', 'leader AF_UNIX socket path')
    .requiredOption('--cwd <path>', 'workspace root')
    .requiredOption('--sid-file <path>', 'file to write the established session id into')
    .requiredOption('--bin <path>', 'grok binary path')
    .option('--seed <sessionId>', 'persisted session id to session/load (cold warm-up)')
    .action(async (opts: { socket: string; cwd: string; sidFile: string; bin: string; seed?: string }) => {
      // runKeepalive never resolves until the leader dies (then it exits the process).
      await runKeepalive({ socket: opts.socket, cwd: opts.cwd, sidFile: opts.sidFile, bin: opts.bin, seed: opts.seed });
    });
}
