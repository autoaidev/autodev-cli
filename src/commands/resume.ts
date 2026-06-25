import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { loadSettingsForRoot } from '../core/settingsLoader';
import { saveSessionId } from '../sessionState';
import { ProviderId, PROVIDERS } from '../providers';

export function resumeCommand(program: Command): void {
  program
    .command('resume <sessionId> [path]')
    .description('Mark a session to resume on next start (sets resumeSession + the session id)')
    .option('-p, --provider <provider>', 'Provider to resume under (e.g. claude-cli, opencode-cli)')
    .action((sessionId: string, workspacePath: string | undefined, opts: { provider?: string }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);
      const provider = (opts.provider ?? settings.provider) as ProviderId;
      if (!(provider in PROVIDERS)) {
        log.error(`Unknown provider "${provider}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
        process.exit(1);
      }
      settings.provider = provider;
      settings.resumeSession = true;
      const file = path.join(cwd, '.autodev', 'settings.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      saveSessionId(cwd, provider, sessionId);
      log.success(`Will resume ${provider} session ${sessionId} on next start.`);
    });
}
