// Minimal entry for the DETACHED grok leader keepalive (Layer B). Parses argv by
// hand and calls runKeepalive — NO commander / CLI graph, so the background holder
// loads instantly and can't die on a missing dependency. Spawned by ensureLeader
// as `node <this> --socket … --cwd … --sid-file … --bin … [--seed …]`.
import { runKeepalive } from './keepalive';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const socket = arg('--socket');
const cwd = arg('--cwd');
const sidFile = arg('--sid-file');
const bin = arg('--bin');
const seed = arg('--seed');
if (!socket || !cwd || !sidFile || !bin) {
  process.stderr.write('grok keepalive: missing required arg (--socket/--cwd/--sid-file/--bin)\n');
  process.exit(2);
}
void runKeepalive({ socket, cwd, sidFile, bin, seed });
