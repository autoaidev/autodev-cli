import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';

interface TailOpts {
  raw?: boolean;
}

/**
 * Print the most recent CLI output for an agent in the workspace.
 *
 * Each task dispatched by the loop tees Claude/Copilot/OpenCode's stdout into
 *   <root>/.autodev/output/<provider>/<messageId>.txt
 * The pointer file <provider>.latest holds the current messageId. Reading
 * that file gives us the final message Claude wrote when it finished the
 * task — useful for surfacing the agent's own summary instead of just the
 * loop's "Task done" log line.
 */
export function tailOutputCommand(program: Command): void {
  program
    .command('tail-output [path]')
    .description('Print the agent CLI\'s most recent stdout (final message)')
    .option('--raw', 'Print raw bytes (no BOM stripping)')
    .action((workspacePath: string | undefined, opts: TailOpts) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const outputDir = path.join(cwd, '.autodev', 'output');
      if (!fs.existsSync(outputDir)) {
        log.error(`No .autodev/output directory in ${cwd}`);
        process.exit(1);
      }

      const pointers = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.latest'))
        .map(f => ({
          provider: f.replace(/\.latest$/, ''),
          file: path.join(outputDir, f),
          mtime: fs.statSync(path.join(outputDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (pointers.length === 0) {
        log.error('No .latest pointer found - has the loop run yet?');
        process.exit(1);
      }

      const ptr = pointers[0];
      const messageId = fs.readFileSync(ptr.file, 'utf8').trim();
      const txtFile = path.join(outputDir, ptr.provider, `${messageId}.txt`);

      if (!fs.existsSync(txtFile)) {
        log.error(`Output file missing: ${txtFile}`);
        process.exit(1);
      }

      log.info(`provider:  ${ptr.provider}`);
      log.info(`messageId: ${messageId}`);
      log.info(`file:      ${txtFile}`);
      log.plain('');

      const buf = fs.readFileSync(txtFile);
      let text: string;
      if (!opts.raw && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.slice(2).toString('utf16le');
      } else if (!opts.raw && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        text = buf.slice(2).swap16().toString('utf16le');
      } else if (!opts.raw && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        text = buf.slice(3).toString('utf8');
      } else {
        text = buf.toString('utf8');
      }

      console.log(text.trim() || '(empty - task may still be running)');
    });
}
