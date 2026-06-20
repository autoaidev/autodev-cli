import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { restoreAgentBackup } from 'autoaidev/agentBackup';
import {
  IdeId,
  isIdeId,
  launchIde,
  isAutodevExtensionInstalled,
  installAutodevExtension,
  findBundledVsix,
} from '../launchIde';

interface ImportOpts {
  ide?: string;
  extension?: boolean;
}

export function importCommand(program: Command): void {
  program
    .command('import <zipFile> [destPath]')
    .description(
      'Restore an agent backup ZIP into a destination folder. ' +
      'Extracts workspace state and rewires session traces for the new location.',
    )
    .option('--ide <ide>', 'Open the restored workspace in an IDE after restore: vscode | cursor')
    .option('--no-extension', 'Skip auto-installing the autoaidev extension (with --ide)')
    .action(async (zipFile: string, destPath: string | undefined, opts: ImportOpts) => {
      const zipPath = path.resolve(zipFile);
      const destRoot = destPath ? path.resolve(destPath) : process.cwd();

      log.section('📥 AutoAIDev — Import Agent Backup');
      log.info(`ZIP       : ${zipPath}`);
      log.info(`Dest      : ${destRoot}`);
      log.plain('');

      try {
        const result = await restoreAgentBackup(zipPath, destRoot);

        log.success(`Workspace files restored: ${result.workspaceFiles}`);

        if (Object.keys(result.restoredByProvider).length > 0) {
          log.info('Session traces restored:');
          for (const [id, n] of Object.entries(result.restoredByProvider)) {
            log.gray(`  ✓ ${id}: ${n} file(s)`);
          }
        } else {
          log.warn('No provider session traces to restore (workspace state only).');
        }

        if (!result.manifestRestored) {
          log.warn('Manifest not found in archive — session IDs not verified.');
        }

        log.plain('');
        log.success(`Restored to: ${destRoot}`);
        log.info('Edit TODO.md then run: autodev start');

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
          launchIde(ide, destRoot);
        }
      } catch (err: unknown) {
        log.error(`Import failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
