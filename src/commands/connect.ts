import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { applyWsUrl, applySetupUrl } from '../connect';

interface ConnectOpts {
  url?: string;
  setupUrl?: string;
  sessionName?: string;
}

export function connectCommand(program: Command): void {
  program
    .command('connect [path]')
    .description('Bind this workspace to a pixel-office WebSocket endpoint')
    .option('--url <wsurl>', 'Full ws://… or wss://… URL (with ?token=&endpoint=)')
    .option('--setup-url <url>', 'Signed pixel-office setup URL — credentials are fetched from it')
    .option('--session-name <name>', 'Session display name (opencode --title, copilot --name, shown in pixel-office)')
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
        // Persist the session display name into the same settings file the
        // bind just wrote, so providers + pixel-office pick it up.
        if (opts.sessionName) {
          const sp = path.join(cwd, '.autodev', 'settings.json');
          const cur = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
          cur.sessionName = opts.sessionName;
          fs.writeFileSync(sp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
          log.gray(`  session name: ${opts.sessionName}`);
        }
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
