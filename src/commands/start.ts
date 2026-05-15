import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { AutoDev, LoopStartOptions } from 'autoaidev/sdk';

const PROVIDERS = ['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-tui', 'opencode-cli', 'opencode-sdk'] as const;

export function startCommand(program: Command): void {
  program
    .command('start [path]')
    .description('Start the autonomous task loop in a workspace directory')
    .option(
      '-p, --provider <provider>',
      `AI provider: ${PROVIDERS.join(' | ')}`,
      'claude-cli',
    )
    .option('--todo <file>', 'Path to TODO.md (relative to workspace)', 'TODO.md')
    .action(async (workspacePath: string | undefined, opts: { provider: string; todo: string }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const todoFile = path.resolve(cwd, opts.todo);

      if (!PROVIDERS.includes(opts.provider as typeof PROVIDERS[number])) {
        log.error(`Unknown provider "${opts.provider}". Valid: ${PROVIDERS.join(', ')}`);
        process.exit(1);
      }

      if (!fs.existsSync(todoFile)) {
        log.error(`No TODO.md found at ${todoFile}`);
        log.info('Run `autodev init` to create a starter TODO.md');
        process.exit(1);
      }

      log.section('🤖 AutoAIDev — Autonomous Task Loop');
      log.info(`Workspace : ${cwd}`);
      log.info(`Provider  : ${opts.provider}`);
      log.info(`TODO.md   : ${todoFile}`);
      log.plain('');
      log.gray('Press Ctrl+C to stop the loop gracefully.\n');

      // Graceful shutdown on Ctrl+C
      process.on('SIGINT', () => {
        log.warn('\n⏹  Stopping task loop…');
        AutoDev.loop.stop();
      });

      try {
        const options: LoopStartOptions = {
          cwd,
          provider: opts.provider as LoopStartOptions['provider'],
          log: log.auto,
        };
        await AutoDev.loop.start(options);
        log.success('\n✅ Task loop finished.');
      } catch (err: unknown) {
        log.error(`Loop error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
