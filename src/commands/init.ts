import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { SETTINGS_DEFAULTS } from 'autoaidev/settings';
import { installHooks, areHooksInstalled } from 'autoaidev/hooks';
import {
  IdeId,
  isIdeId,
  launchIde,
  isAutodevExtensionInstalled,
  installAutodevExtension,
  findBundledVsix,
} from '../launchIde';

const TODO_TEMPLATE = `# TODO

## Tasks

- [ ] Example task — replace with your real task

`;

interface InitOpts {
  provider: string;
  force?: boolean;
  ide?: string;
  // Commander maps --no-foo to opts.foo === false (default true).
  launch?: boolean;
  extension?: boolean;
  hooks?: boolean;
}

export function runInit(workspacePath: string | undefined, opts: InitOpts): void {
  const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
    log.info(`Created workspace directory: ${cwd}`);
  }

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

  // Create .autodev/settings.json (canonical path; legacy .vscode/autodev.json
  // is still read transparently for back-compat).
  const autodevDir = path.join(cwd, '.autodev');
  const configPath = path.join(autodevDir, 'settings.json');
  const legacyConfig = path.join(cwd, '.vscode', 'autodev.json');
  if (fs.existsSync(configPath) && !opts.force) {
    log.warn(`.autodev/settings.json already exists (use --force to overwrite)`);
  } else {
    if (!fs.existsSync(autodevDir)) { fs.mkdirSync(autodevDir, { recursive: true }); }
    let settings: Record<string, unknown> = {
      ...SETTINGS_DEFAULTS,
      provider: opts.provider,
      // hooks default ON for new workspaces — without them, pixel-office never
      // sees tool_start/tool_end/etc. and the office UI looks empty.
      hooksEnabled: true,
      hooksScope: 'project',
    };
    // If a legacy file exists, port its values forward so users keep their config.
    if (fs.existsSync(legacyConfig)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyConfig, 'utf8')) as Record<string, unknown>;
        settings = { ...settings, ...legacy };
        log.gray(`Imported config from legacy ${legacyConfig}`);
      } catch { /* ignore parse errors */ }
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8');
    log.success(`Created ${configPath}`);
  }

  // Install Claude/Copilot hook scripts so pixel-office sees per-tool events
  // for this workspace. Skipped with --no-hooks, or if already installed.
  if (opts.hooks !== false) {
    try {
      if (!areHooksInstalled('project', cwd)) {
        installHooks('project', cwd);
        log.success('Installed agent hooks (Claude + Copilot) under .claude/.github/copilot');
      } else {
        log.gray('Agent hooks already installed.');
      }
    } catch (err) {
      log.warn(`Hooks install skipped: ${(err as Error).message}`);
    }
  }

  // Add .autodev/ to .gitignore (covers settings + runtime state).
  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = '.autodev/';
  try {
    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!content.split('\n').map(l => l.trim()).includes(entry)) {
      if (content.length > 0 && !content.endsWith('\n')) { content += '\n'; }
      fs.writeFileSync(gitignorePath, content + `${entry}\n`, 'utf8');
      log.success(`Added ${entry} to .gitignore`);
    }
  } catch { /* ignore */ }

  // Optional IDE launch
  if (opts.ide) {
    if (!isIdeId(opts.ide)) {
      log.error(`Unknown --ide value "${opts.ide}". Valid: vscode | cursor`);
      process.exit(1);
    }
    const ide: IdeId = opts.ide;

    if (opts.extension !== false && !isAutodevExtensionInstalled(ide)) {
      const vsix = findBundledVsix();
      installAutodevExtension(ide, vsix ?? undefined);
    }

    if (opts.launch !== false) {
      launchIde(ide, cwd);
    }
  }

  log.plain('');
  log.success('Done! Edit TODO.md then run:');
  log.info(`  autodev start ${workspacePath ?? '.'}`);
}

export function initCommand(program: Command): void {
  program
    .command('init [path]')
    .description('Initialise a workspace: create TODO.md and .autodev/settings.json')
    .option('-p, --provider <provider>', 'Default AI provider', 'claude-cli')
    .option('--ide <ide>', 'Launch IDE after init: vscode | cursor')
    .option('--no-launch', 'Do not actually launch the IDE (only install extension)')
    .option('--no-extension', 'Skip auto-installing the autoaidev extension')
    .option('--no-hooks', 'Skip auto-installing agent hooks')
    .option('--force', 'Overwrite existing files')
    .action((workspacePath: string | undefined, opts: InitOpts) => {
      runInit(workspacePath, opts);
    });
}
