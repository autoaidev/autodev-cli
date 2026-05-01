import * as path from 'path';
import { Command } from 'commander';
import { startCommand }  from './commands/start';
import { initCommand, runInit }   from './commands/init';
import { configCommand } from './commands/config';
import { statusCommand } from './commands/status';
import { upCommand, launchCommand } from './commands/up';
import { connectCommand } from './commands/connect';
import { tailOutputCommand } from './commands/tailOutput';
import { applyWsUrl, applySetupUrl } from './connect';
import { log } from './logger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

interface RootOpts {
  ide?: string;
  provider: string;
  force?: boolean;
  // Commander: --no-extension → opts.extension === false (default true).
  extension?: boolean;
  connect?: string;
  setupUrl?: string;
}

const program = new Command()
  .name('autodev')
  .description('AutoAIDev — autonomous AI task loop with optional IDE launcher and pixel-office connect')
  .version(version)
  // Without this, the program-level --ide / --setup-url / --connect options
  // greedily eat the same option names from subcommands. With it, anything
  // after a subcommand name is parsed against that subcommand only.
  .enablePositionalOptions()
  // Top-level shortcuts. Any combination is valid:
  //   autodev --ide=vscode .
  //   autodev --setup-url=https://… .
  //   autodev --setup-url=https://… --ide=cursor .
  //   autodev --connect=wss://host?token=…&endpoint=… .
  .option('--ide <ide>', 'Init and launch the workspace in an IDE (vscode | cursor)')
  .option('-p, --provider <provider>', 'Default AI provider', 'claude-cli')
  .option('--force', 'Overwrite existing files (with --ide)')
  .option('--no-extension', 'Skip auto-installing the autoaidev extension (with --ide)')
  .option('--connect <wsurl>', 'Bind the workspace to a ws:// / wss:// URL with ?token=&endpoint=')
  .option('--setup-url <url>', 'Bind the workspace using a signed pixel-office setup URL')
  .argument('[path]', 'Workspace path (default: cwd)')
  .action(async (maybePath: string | undefined, opts: RootOpts) => {
    const cwd = maybePath ? path.resolve(maybePath) : process.cwd();
    const didSomething = !!(opts.ide || opts.connect || opts.setupUrl);
    if (!didSomething) { program.help(); return; }

    if (opts.ide) {
      runInit(maybePath, {
        ide: opts.ide,
        provider: opts.provider,
        force: opts.force,
        extension: opts.extension,
      });
    }

    try {
      if (opts.setupUrl) { await applySetupUrl(cwd, opts.setupUrl); }
      else if (opts.connect) { applyWsUrl(cwd, opts.connect); }
    } catch (err) {
      log.error((err as Error).message);
      process.exit(1);
    }
  });

startCommand(program);
initCommand(program);
upCommand(program);
launchCommand(program);
connectCommand(program);
tailOutputCommand(program);
configCommand(program);
statusCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
