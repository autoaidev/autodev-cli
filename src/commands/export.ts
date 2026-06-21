import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { createAgentBackup } from '../agentBackup';

interface ExportOpts {
  output?: string;
}

export function exportCommand(program: Command): void {
  program
    .command('export [path]')
    .description('Export an agent backup ZIP (workspace state + portable session traces)')
    .option(
      '-o, --output <file>',
      'Destination ZIP path (default: <workspace>/agent.zip)',
    )
    .action(async (workspacePath: string | undefined, opts: ExportOpts) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const destPath = opts.output
        ? path.resolve(opts.output)
        : path.join(cwd, 'agent.zip');

      log.section('📦 AutoAIDev — Export Agent Backup');
      log.info(`Workspace : ${cwd}`);
      log.info(`Output    : ${destPath}`);
      log.plain('');

      try {
        const result = await createAgentBackup(cwd, destPath);
        if (result.capturedProviders.length > 0) {
          log.success(`Traces captured: ${result.capturedProviders.join(', ')}`);
        } else {
          log.warn('No portable provider traces found — workspace state only.');
        }

        // Per-provider summary
        for (const [id, entry] of Object.entries(result.providers)) {
          const icon = entry.tracesCaptured ? '✓' : '–';
          const ids = entry.discoveredSessionIds.length > 0
            ? ` (${entry.discoveredSessionIds.length} session(s))`
            : '';
          log.gray(`  ${icon} ${id} [${entry.portability}]${ids}`);
        }

        log.plain('');
        log.success(`Saved: ${destPath}`);
      } catch (err: unknown) {
        log.error(`Export failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
