import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { applyWsUrl, applySetupUrl } from '../connect';

interface ConnectOpts {
  url?: string;
  setupUrl?: string;
  sessionName?: string;
  fileBrowser?: boolean;
}

export function connectCommand(program: Command): void {
  program
    .command('connect [path]')
    .description('Bind this workspace to a pixel-office WebSocket endpoint')
    .option('--url <wsurl>', 'Full ws://… or wss://… URL (with ?token=&endpoint=)')
    .option('--setup-url <url>', 'Signed pixel-office setup URL — credentials are fetched from it')
    .option('--session-name <name>', 'Session display name (opencode --title, copilot --name, shown in pixel-office)')
    .option('--file-browser', 'Enable the file browser for this agent (sets enableFileBrowser=true)')
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
        // Persist extra settings into the same file the bind just wrote, so
        // providers + pixel-office pick them up.
        if (opts.sessionName || opts.fileBrowser) {
          const sp = path.join(cwd, '.autodev', 'settings.json');
          const cur = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
          if (opts.sessionName) { cur.sessionName = opts.sessionName; log.gray(`  session name: ${opts.sessionName}`); }
          if (opts.fileBrowser) { cur.enableFileBrowser = true; log.gray('  file browser: enabled'); }
          fs.writeFileSync(sp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
        }
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
