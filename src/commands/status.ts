import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { parseTodo, countRemaining, Task } from 'autoaidev/todo';
import { loadSettingsForRoot } from 'autoaidev/settings';

export function statusCommand(program: Command): void {
  program
    .command('status [path]')
    .description('Show TODO.md task summary for a workspace')
    .option('--all', 'Also list completed tasks')
    .action((workspacePath: string | undefined, opts: { all: boolean }) => {
      const cwd      = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);
      const todoFile = settings.todoPath
        ? path.resolve(cwd, settings.todoPath)
        : path.join(cwd, 'TODO.md');

      if (!fs.existsSync(todoFile)) {
        log.error(`No TODO.md found at ${todoFile}`);
        log.info('Run `autodev init` to create one.');
        process.exit(1);
      }

      const tasks    = parseTodo(todoFile);
      const todo     = tasks.filter(t => t.status === 'todo');
      const active   = tasks.filter(t => t.status === 'in-progress');
      const done     = tasks.filter(t => t.status === 'done');
      const remaining = countRemaining(tasks);

      log.section('📋 AutoDev Status');
      log.info(`Workspace  : ${cwd}`);
      log.info(`TODO.md    : ${todoFile}`);
      log.info(`Provider   : ${settings.provider}`);
      log.plain('');

      log.plain(`  Remaining : ${remaining}`);
      log.plain(`  Todo      : ${todo.length}`);
      log.plain(`  Active    : ${active.length}`);
      log.plain(`  Done      : ${done.length}`);
      log.plain('');

      if (active.length > 0) {
        log.warn('⏳ In progress:');
        for (const t of active) { log.warn(`   [~] ${t.text}`); }
        log.plain('');
      }

      if (todo.length > 0) {
        log.info('📌 Next tasks:');
        for (const t of todo.slice(0, 10)) { log.plain(`   [ ] ${t.text}`); }
        if (todo.length > 10) { log.gray(`   … and ${todo.length - 10} more`); }
        log.plain('');
      }

      if (opts.all && done.length > 0) {
        log.success('✅ Completed:');
        for (const t of done) {
          const date = t.completedDate ? ` (${t.completedDate})` : '';
          log.gray(`   [x] ${t.text}${date}`);
        }
        log.plain('');
      }

      if (remaining === 0) {
        log.success('✅ All tasks complete!');
      }
    });
}
