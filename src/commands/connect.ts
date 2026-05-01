import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { applyWsUrl, applySetupUrl } from '../connect';

interface ConnectOpts {
  url?: string;
  setupUrl?: string;
}

export function connectCommand(program: Command): void {
  program
    .command('connect [path]')
    .description('Bind this workspace to a pixel-office WebSocket endpoint')
    .option('--url <wsurl>', 'Full ws://… or wss://… URL (with ?token=&endpoint=)')
    .option('--setup-url <url>', 'Signed pixel-office setup URL — credentials are fetched from it')
    .action(async (workspacePath: string | undefined, opts: ConnectOpts) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      try {
        if (opts.setupUrl) {
          await applySetupUrl(cwd, opts.setupUrl);
        } else if (opts.url) {
          applyWsUrl(cwd, opts.url);
        } else {
          log.error('Pass either --setup-url=<url> or --url=<wsurl>.');
          process.exit(1);
        }
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
