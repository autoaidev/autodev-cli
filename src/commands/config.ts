import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { AutodevSettings, SETTINGS_DEFAULTS, loadSettingsForRoot } from 'autoaidev/settings';

function configPath(cwd: string): string {
  return path.join(cwd, '.vscode', 'autodev.json');
}

function saveSettings(cwd: string, settings: AutodevSettings): void {
  const file = configPath(cwd);
  const dir  = path.dirname(file);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function configCommand(program: Command): void {
  const cmd = program
    .command('config')
    .description('Read or write workspace configuration (.vscode/autodev.json)')
    .argument('[path]', 'Workspace directory (default: cwd)');

  // autodev config [path]  — print all settings
  cmd.action((workspacePath: string | undefined) => {
    const cwd      = workspacePath ? path.resolve(workspacePath) : process.cwd();
    const settings = loadSettingsForRoot(cwd);
    log.section('⚙  AutoDev Config');
    log.info(`File: ${configPath(cwd)}`);
    log.plain('');
    for (const [k, v] of Object.entries(settings)) {
      const masked = typeof v === 'string' && (k.toLowerCase().includes('token') || k.toLowerCase().includes('password') || k.toLowerCase().includes('apikey'))
        ? (v ? '***' : '')
        : String(v);
      log.plain(`  ${k.padEnd(28)} ${masked}`);
    }
  });

  // autodev config set <key> <value> [path]
  cmd
    .command('set <key> <value> [path]')
    .description('Set a config value')
    .action((key: string, value: string, workspacePath: string | undefined) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);

      if (!(key in SETTINGS_DEFAULTS)) {
        log.error(`Unknown key "${key}". Valid keys: ${Object.keys(SETTINGS_DEFAULTS).join(', ')}`);
        process.exit(1);
      }

      const defaultVal = (SETTINGS_DEFAULTS as unknown as Record<string, unknown>)[key];
      let parsed: unknown;
      if (typeof defaultVal === 'number')  { parsed = Number(value); }
      else if (typeof defaultVal === 'boolean') { parsed = value === 'true' || value === '1'; }
      else { parsed = value; }

      (settings as unknown as Record<string, unknown>)[key] = parsed;
      saveSettings(cwd, settings);
      log.success(`Set ${key} = ${value}`);
    });

  // autodev config get <key> [path]
  cmd
    .command('get <key> [path]')
    .description('Get a config value')
    .action((key: string, workspacePath: string | undefined) => {
      const cwd      = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);
      if (!(key in settings)) {
        log.error(`Unknown key "${key}"`);
        process.exit(1);
      }
      console.log(String((settings as unknown as Record<string, unknown>)[key]));
    });
}
