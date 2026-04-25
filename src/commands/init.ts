import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { SETTINGS_DEFAULTS } from 'autoaidev/settings';

const TODO_TEMPLATE = `# TODO

## Tasks

- [ ] Example task — replace with your real task

`;

export function initCommand(program: Command): void {
  program
    .command('init [path]')
    .description('Initialise a workspace: create TODO.md and .vscode/autodev.json')
    .option('-p, --provider <provider>', 'Default AI provider', 'claude-cli')
    .option('--force', 'Overwrite existing files')
    .action((workspacePath: string | undefined, opts: { provider: string; force: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();

      log.section('🛠  AutoAIDev — Init');
      log.info(`Workspace: ${cwd}`);

      // Create TODO.md
      const todoPath = path.join(cwd, 'TODO.md');
      if (fs.existsSync(todoPath) && !opts.force) {
        log.warn(`TODO.md already exists (use --force to overwrite)`);
      } else {
        fs.writeFileSync(todoPath, TODO_TEMPLATE, 'utf8');
        log.success(`Created ${todoPath}`);
      }

      // Create .vscode/autodev.json
      const vscodeDir = path.join(cwd, '.vscode');
      const configPath = path.join(vscodeDir, 'autodev.json');
      if (fs.existsSync(configPath) && !opts.force) {
        log.warn(`.vscode/autodev.json already exists (use --force to overwrite)`);
      } else {
        if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
        const settings = { ...SETTINGS_DEFAULTS, provider: opts.provider };
        fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8');
        log.success(`Created ${configPath}`);
      }

      // Add .vscode/autodev.json to .gitignore
      const gitignorePath = path.join(cwd, '.gitignore');
      const entry = '.vscode/autodev.json';
      try {
        let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        if (!content.split('\n').map(l => l.trim()).includes(entry)) {
          if (content.length > 0 && !content.endsWith('\n')) { content += '\n'; }
          fs.writeFileSync(gitignorePath, content + `${entry}\n`, 'utf8');
          log.success(`Added ${entry} to .gitignore`);
        }
      } catch { /* ignore */ }

      log.plain('');
      log.success('Done! Edit TODO.md then run:');
      log.info(`  autodev start ${workspacePath ?? '.'}`);
    });
}
