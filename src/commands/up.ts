import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { runInit } from './init';
import {
  IdeId,
  isIdeId,
  launchIde,
  isAutodevExtensionInstalled,
  installAutodevExtension,
  findBundledVsix,
} from '../launchIde';

interface UpOpts {
  ide: string;
  provider: string;
  force?: boolean;
  // Commander: --no-extension → opts.extension === false (default true).
  extension?: boolean;
}

export function upCommand(program: Command): void {
  program
    .command('up [path]')
    .description('Init the workspace and launch it in an IDE (shortcut for init --ide=…)')
    .requiredOption('--ide <ide>', 'IDE to launch: vscode | cursor')
    .option('-p, --provider <provider>', 'Default AI provider', 'claude-cli')
    .option('--no-extension', 'Skip auto-installing the autoaidev extension')
    .option('--force', 'Overwrite existing files')
    .action((workspacePath: string | undefined, opts: UpOpts) => {
      runInit(workspacePath, {
        ide: opts.ide,
        provider: opts.provider,
        force: opts.force,
        extension: opts.extension,
      });
    });
}

interface LaunchOpts {
  ide: string;
  extension?: boolean;
}

export function launchCommand(program: Command): void {
  program
    .command('launch [path]')
    .description('Open an existing workspace in an IDE (no init)')
    .requiredOption('--ide <ide>', 'IDE to launch: vscode | cursor')
    .option('--no-extension', 'Skip auto-installing the autoaidev extension')
    .action((workspacePath: string | undefined, opts: LaunchOpts) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      if (!isIdeId(opts.ide)) {
        log.error(`Unknown --ide value "${opts.ide}". Valid: vscode | cursor`);
        process.exit(1);
      }
      const ide: IdeId = opts.ide;

      if (opts.extension !== false && !isAutodevExtensionInstalled(ide)) {
        const vsix = findBundledVsix();
        installAutodevExtension(ide, vsix ?? undefined);
      }
      const ok = launchIde(ide, cwd);
      if (!ok) { process.exit(1); }
    });
}
