import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { collectSessions } from '../sessions';
import { ProviderId } from '../providers';
import { collectAllSessions, readSessionTranscript, normalizeSessionProvider, SessionProvider } from '../sessionsGlobal';

export function sessionsCommand(program: Command): void {
  program
    .command('sessions [path]')
    .description('List existing AI sessions for a workspace (id, name, last updated)')
    .option('--json', 'Output JSON')
    .option('--all', 'List sessions across ALL workspaces on this machine (ignores [path]); normalized shape with provider + cwd')
    .option('-p, --provider <provider>', 'Only list sessions for this provider family (claude|opencode|grok|copilot); omit to list all inspectable stores')
    .action((workspacePath: string | undefined, opts: { json?: boolean; all?: boolean; provider?: string }) => {
      // --- Global mode: every workspace, normalized cross-provider shape ---
      if (opts.all) {
        const fam = normalizeSessionProvider(opts.provider);
        const sessions = collectAllSessions(fam);
        if (opts.json) { process.stdout.write(JSON.stringify(sessions, null, 2) + '\n'); return; }
        log.section('🗂  Sessions (all workspaces)');
        if (sessions.length === 0) { log.gray('  (no inspectable sessions found)'); return; }
        for (const s of sessions) {
          const when = s.updated ? new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ') : '—';
          log.plain(`  [${s.provider}] ${s.name}  ·  ${s.id}  ·  ${s.cwd || '?'}  ·  ${when}`);
        }
        return;
      }

      // --- Per-workspace mode (unchanged) ---
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const sessions = collectSessions(cwd, opts.provider as ProviderId | undefined);
      if (opts.json) { process.stdout.write(JSON.stringify(sessions, null, 2) + '\n'); return; }
      log.section('🗂  Sessions');
      log.info(`Workspace : ${cwd}`);
      if (sessions.length === 0) { log.gray('  (no inspectable sessions found)'); return; }
      for (const s of sessions) {
        const when = s.updated ? new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ') : '—';
        log.plain(`  [${s.provider}] ${s.name}  ·  ${s.id}  ·  ${when}`);
      }
    });

  program
    .command('session-show <id>')
    .description('Print a session transcript as a normalized message array (--json)')
    .requiredOption('-p, --provider <provider>', 'Provider family the session belongs to (claude|grok|opencode|copilot)')
    .option('--json', 'Output JSON')
    .option('--file <file>', 'Explicit transcript file (claude) — skips the id lookup')
    .option('--cwd <cwd>', 'Workspace path hint (grok) — speeds up transcript resolution')
    .option('--limit <n>', 'Cap the number of messages returned (default 400)', (v) => parseInt(v, 10))
    .action((id: string, opts: { provider: string; json?: boolean; file?: string; cwd?: string; limit?: number }) => {
      const fam = normalizeSessionProvider(opts.provider);
      if (!fam) {
        if (opts.json) { process.stdout.write('[]\n'); }
        else { log.error(`Unknown provider "${opts.provider}" (expected claude|grok|opencode|copilot)`); }
        return;
      }
      const msgs = readSessionTranscript(fam as SessionProvider, id, { file: opts.file, cwd: opts.cwd, limit: opts.limit });
      if (opts.json) { process.stdout.write(JSON.stringify(msgs, null, 2) + '\n'); return; }
      log.section(`🗂  ${fam} session ${id.slice(0, 8)} (${msgs.length} msgs)`);
      if (msgs.length === 0) { log.gray('  (no messages / transcript not found)'); return; }
      for (const m of msgs) {
        log.plain(`  [${m.role}] ${m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text}`);
      }
    });
}
