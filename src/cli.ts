import { Command } from 'commander';
import { startCommand }  from './commands/start';
import { initCommand }   from './commands/init';
import { configCommand } from './commands/config';
import { statusCommand } from './commands/status';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

const program = new Command()
  .name('autodev')
  .description('AutoAIDev — autonomous AI task loop without VS Code')
  .version(version);

startCommand(program);
initCommand(program);
configCommand(program);
statusCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
