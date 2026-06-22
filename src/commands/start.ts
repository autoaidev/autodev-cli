import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { AutoDev, LoopStartOptions } from '../sdk';

const PROVIDERS = ['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk', 'grok-tui'] as const;

export function startCommand(program: Command): void {
  program
    .command('start [path]')
    .description('Start the autonomous task loop in a workspace directory')
    .option(
      '-p, --provider <provider>',
      `AI provider: ${PROVIDERS.join(' | ')} (default: .autodev/settings.json, else claude-cli)`,
    )
    .option('--todo <file>', 'Path to TODO.md (relative to workspace)', 'TODO.md')
    .option('--once', 'Run until the TODO drains, then exit (default: poll forever)')
    .action(async (workspacePath: string | undefined, opts: { provider?: string; todo: string; once?: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const todoFile = path.resolve(cwd, opts.todo);

      // Only validate when explicitly provided; otherwise the SDK resolves the
      // provider from .autodev/settings.json (parity with the VS Code shell).
      if (opts.provider && !PROVIDERS.includes(opts.provider as typeof PROVIDERS[number])) {
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
      log.info(`Provider  : ${opts.provider ?? '(from .autodev/settings.json)'}`);
      log.info(`TODO.md   : ${todoFile}`);
      log.plain('');
      log.gray('Press Ctrl+C to stop the loop gracefully.\n');

      // Graceful shutdown on Ctrl+C. stop() closes the persistent SDK servers,
      // but give cleanup a brief grace window to flush (webhook offline, file
      // handles) then force-exit — otherwise a lingering timer/handle can keep
      // the process alive. A second Ctrl+C exits immediately.
      let stopping = false;
      process.on('SIGINT', () => {
        if (stopping) { process.exit(130); }
        stopping = true;
        log.warn('\n⏹  Stopping task loop…');
        AutoDev.loop.stop();
        setTimeout(() => process.exit(0), 1500).unref();
      });

      try {
        const options: LoopStartOptions = {
          cwd,
          ...(opts.provider ? { provider: opts.provider as LoopStartOptions['provider'] } : {}),
          ...(opts.once ? { once: true } : {}),
          log: log.auto,
        };
        await AutoDev.loop.start(options);
        log.success('\n✅ Task loop finished.');
        if (opts.once) { process.exit(0); }
      } catch (err: unknown) {
        log.error(`Loop error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
