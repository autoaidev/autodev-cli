import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';
import { applyWsUrl, applySetupUrl } from '../connect';
import { ConfigManager } from '../configManager';

interface ConnectOpts {
  url?: string;
  setupUrl?: string;
  sessionName?: string;
  fileBrowser?: boolean;
  mcpOnly?: boolean;
}

export function connectCommand(program: Command): void {
  program
    .command('connect [path]')
    .description('Bind this workspace to a pixel-office WebSocket endpoint')
    .option('--url <wsurl>', 'Full ws://… or wss://… URL (with ?token=&endpoint=)')
    .option('--setup-url <url>', 'Signed pixel-office setup URL — credentials are fetched from it')
    .option('--session-name <name>', 'Session display name (opencode --title, copilot --name, shown in pixel-office)')
    .option('--file-browser', 'Enable the file browser for this agent (sets enableFileBrowser=true)')
    .option('--mcp-only', 'MCP-only agent (no autodev loop): wire the office OPERATOR MCP (autodev mcp-operate) into the provider config so a pure-MCP client — e.g. opencode/Kimi — is a first-class online office agent with tasks + A2A')
    .action(async (workspacePath: string | undefined, opts: ConnectOpts) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      try {
        if (opts.setupUrl) {
          await applySetupUrl(cwd, opts.setupUrl);
        } else if (opts.url) {
          applyWsUrl(cwd, opts.url);
        } else {
          log.error('Pass either --setup-url=<url> or --url=<wsurl>.');
          process.exit(1);
        }
        // Persist extra settings into the same file the bind just wrote, so
        // providers + pixel-office pick them up.
        if (opts.sessionName || opts.fileBrowser || opts.mcpOnly) {
          const sp = path.join(cwd, '.autodev', 'settings.json');
          const cur = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {};
          if (opts.sessionName) { cur.sessionName = opts.sessionName; log.gray(`  session name: ${opts.sessionName}`); }
          if (opts.fileBrowser) { cur.enableFileBrowser = true; log.gray('  file browser: enabled'); }
          if (opts.mcpOnly) { cur.mcpOnly = true; log.gray('  mode: MCP-only (operator MCP wired for a no-loop client)'); }
          fs.writeFileSync(sp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
        }
        // An MCP-only client never runs `autodev start`, so the task loop's
        // config sync never fires — wire the operator MCP into the provider
        // config files (opencode.json, .mcp.json, …) here so the client is a
        // ready office agent the moment `connect` returns.
        if (opts.mcpOnly) {
          ConfigManager.syncProjectMcpServers(cwd, (m) => log.gray(`  ${m}`));
        }
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
