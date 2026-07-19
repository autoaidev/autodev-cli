import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { AutoDev, LoopStartOptions } from '../sdk';
import { CLI_VERSION } from '../version';
import { foreignLoopOwner, readPresenceLock } from '../presenceGuard';

const PROVIDERS = ['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk', 'grok-cli', 'grok-tui'] as const;

export function startCommand(program: Command): void {
  program
    .command('start [path]')
    .description('Start the autonomous task loop in a workspace directory')
    .option(
      '-p, --provider <provider>',
      `AI provider: ${PROVIDERS.join(' | ')} (default: .autodev/settings.json, else claude-tui)`,
    )
    .option('--todo <file>', 'Path to TODO.md (relative to workspace)', 'TODO.md')
    .option('--once', 'Run until the TODO drains, then exit (default: poll forever)')
    .option('--session-name <name>', 'Display name for this session (opencode --title, copilot --name, shown in pixel-office)')
    .option('--force', 'Start even if another loop already owns this workspace (bypass the duplicate-loop guard)')
    .action(async (workspacePath: string | undefined, opts: { provider?: string; todo: string; once?: boolean; sessionName?: string; force?: boolean }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const todoFile = path.resolve(cwd, opts.todo);

      // ── Duplicate-loop guard ───────────────────────────────────────────────
      // The running `autodev start` loop drops .autodev/ws-presence.lock
      // ({pid, slug, ts}) once its WS connects and refreshes ts every heartbeat.
      // If a DIFFERENT, still-alive loop already holds a FRESH lock for this
      // workspace, a second loop would open a competing WS that (last-wins on the
      // server's slug index) evicts the first every ~5s — a WebSocket flap. Bail
      // out cleanly instead. --force bypasses (intentional takeover/restart). At
      // boot we haven't written our own lock yet, so the guard only ever sees the
      // OTHER loop's lock — never our own — and never kills a lone re-connecting
      // loop.
      if (!opts.force) {
        const ownerPid = foreignLoopOwner(readPresenceLock(cwd));
        if (ownerPid !== null) {
          log.warn(`⚠ Another autodev loop (pid ${ownerPid}) already owns this workspace — exiting to avoid a duplicate connection.`);
          log.gray('  Run `autodev start --force` to take over anyway.');
          process.exit(0);
        }
      }

      // Parent-death watchdog: when a manager spawns this loop and sets
      // AUTODEV_EXIT_WITH_PARENT=1 (the desktop app does), exit if that parent
      // process disappears — so closing, crashing, or force-quitting the app never
      // leaves an orphaned loop (and its provider subprocess) running as a stale
      // session. SIGINT first for a graceful provider-cleanup shutdown, hard-exit
      // as a fallback. Not armed for a plain terminal `autodev start`.
      if (process.env.AUTODEV_EXIT_WITH_PARENT) {
        const parentPid = process.ppid;
        const wd = setInterval(() => {
          let gone = process.ppid !== parentPid; // reparented ⇒ parent died
          if (!gone && parentPid > 1) { try { process.kill(parentPid, 0); } catch { gone = true; } }
          if (gone) {
            clearInterval(wd);
            process.stderr.write('\n[autodev] parent (app) exited — shutting the loop down to avoid a stale session.\n');
            try { process.kill(process.pid, 'SIGINT'); } catch { /* ignore */ }
            setTimeout(() => process.exit(0), 8000).unref?.();
          }
        }, 4000);
        wd.unref?.();
      }

      // Persist the session display name to .autodev/settings.json so the
      // dispatcher + providers pick it up (opencode --title / copilot --name)
      // and the loop injects it as _session_name for pixel-office.
      if (opts.sessionName) {
        try {
          const sp = path.join(cwd, '.autodev', 'settings.json');
          const cur = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
          cur.sessionName = opts.sessionName;
          fs.mkdirSync(path.dirname(sp), { recursive: true });
          fs.writeFileSync(sp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
          log.info(`Session name: ${opts.sessionName}`);
        } catch (e) { log.warn(`Could not persist session name: ${(e as Error).message}`); }
      }

      // Only validate when explicitly provided; otherwise the SDK resolves the
      // provider from .autodev/settings.json (parity with the VS Code shell).
      if (opts.provider && !PROVIDERS.includes(opts.provider as typeof PROVIDERS[number])) {
        log.error(`Unknown provider "${opts.provider}". Valid: ${PROVIDERS.join(', ')}`);
        process.exit(1);
      }

      if (!fs.existsSync(todoFile)) {
        log.error(`No TODO.md found at ${todoFile}`);
        log.info('Run `autodev init` to create a starter TODO.md');
        process.exit(1);
      }

      log.section('🤖 AutoAIDev — Autonomous Task Loop');
      log.info(`autodev-cli v${CLI_VERSION}`);
      log.info(`Workspace : ${cwd}`);
      log.info(`Provider  : ${opts.provider ?? '(from .autodev/settings.json)'}`);
      log.info(`TODO.md   : ${todoFile}`);
      log.plain('');
      log.gray('Press Ctrl+C to stop the loop gracefully.\n');

      // Graceful shutdown on Ctrl+C. stop() closes the persistent SDK servers,
      // but give cleanup a brief grace window to flush (webhook offline, file
      // handles) then force-exit — otherwise a lingering timer/handle can keep
      // the process alive. A second Ctrl+C exits immediately.
      let stopping = false;
      process.on('SIGINT', () => {
        if (stopping) { process.exit(130); }
        stopping = true;
        log.warn('\n⏹  Stopping task loop…');
        AutoDev.loop.stop();
        setTimeout(() => process.exit(0), 1500).unref();
      });

      // Backstop: an unexpected throw or rejection anywhere in the loop (a
      // hostile WS frame, an I/O error) must not take the whole agent offline
      // requiring a manual respawn. Log and keep the process alive so it stays
      // online and serving. The per-frame try/catch in webSocketPoller is the
      // primary guard; these are the last line of defence.
      process.on('uncaughtException', (err) => {
        log.error(`Uncaught exception (kept alive): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      });
      process.on('unhandledRejection', (reason) => {
        log.error(`Unhandled rejection (kept alive): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
      });

      try {
        const options: LoopStartOptions = {
          cwd,
          ...(opts.provider ? { provider: opts.provider as LoopStartOptions['provider'] } : {}),
          ...(opts.once ? { once: true } : {}),
          log: log.auto,
        };
        await AutoDev.loop.start(options);
        log.success('\n✅ Task loop finished.');
        if (opts.once) { process.exit(0); }
      } catch (err: unknown) {
        log.error(`Loop error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
