import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { collectSessions } from '../sessions';

export function sessionsCommand(program: Command): void {
  program
    .command('sessions [path]')
    .description('List existing AI sessions for a workspace (id, name, last updated)')
    .option('--json', 'Output JSON')
    .action((workspacePath: string | undefined, opts: { json?: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const sessions = collectSessions(cwd);
      if (opts.json) { process.stdout.write(JSON.stringify(sessions, null, 2) + '\n'); return; }
      log.section('🗂  Sessions');
      log.info(`Workspace : ${cwd}`);
      if (sessions.length === 0) { log.gray('  (no inspectable sessions found)'); return; }
      for (const s of sessions) {
        const when = s.updated ? new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ') : '—';
        log.plain(`  [${s.provider}] ${s.name}  ·  ${s.id}  ·  ${when}`);
      }
    });
}
