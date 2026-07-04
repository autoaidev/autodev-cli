import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as readline from 'readline';
import { URL } from 'url';
import { Command } from 'commander';
import { loadSettingsForRoot } from '../core/settingsLoader';

/**
 * `autodev mcp-operate` — run a local stdio MCP server that lets a pure MCP
 * client (Claude Desktop/Code, etc.) operate a pixel-office character with NO
 * autodev loop. It is a transparent JSON-RPC bridge: the client speaks the MCP
 * stdio transport (newline-delimited JSON on stdin/stdout); each request is
 * forwarded to the pixel-office operator MCP (`…/api/office-mcp`) authenticated
 * with the character's api_key, and the response is written back.
 *
 * Why stdio (vs adding the remote HTTP MCP directly): the client adds it with a
 * single command — no remote-server approval friction, and the key/url stay in
 * autodev config instead of being pasted into the client.
 *
 *   claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <…/api/office-mcp>
 *   # or, inside a bound workspace, just:  autodev mcp-operate
 */

/** Derive the operator-MCP URL from a bound workspace's serverBaseUrl. */
function officeMcpUrl(serverBaseUrl: string | undefined): string {
  try {
    const u = new URL(serverBaseUrl || '');
    // serverBaseUrl is derived from wsUrl (wss://host/ws) — normalise to the
    // HTTP origin; the MCP endpoint lives at <origin>/api/office-mcp.
    const proto = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
    return `${proto}//${u.host}/api/office-mcp`;
  } catch {
    return '';
  }
}

/** POST a JSON-RPC message to the remote operator MCP; resolve its JSON reply. */
function proxy(endpoint: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': data.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        // A notification (204/202, no body) has nothing to forward.
        if (!d.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(d) as Record<string, unknown>); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function mcpOperateCommand(program: Command): void {
  program
    .command('mcp-operate [path]')
    .description('Run a stdio MCP server that operates a pixel-office agent (bridges to …/api/office-mcp). Add it with: claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <url>')
    .option('--url <url>', 'Operator MCP URL (…/api/office-mcp). Default: derived from the workspace binding.')
    .option('--key <apiKey>', 'The character api_key (Bearer). Default: the workspace serverApiKey.')
    .action(async (workspacePath: string | undefined, opts: { url?: string; key?: string }) => {
      const cwd = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const settings = loadSettingsForRoot(cwd);
      const endpoint = opts.url || officeMcpUrl(settings.serverBaseUrl);
      const key = opts.key || settings.serverApiKey || '';

      if (!endpoint || !key) {
        process.stderr.write('autodev mcp-operate: need --url and --key (or run inside a workspace bound to an office).\n');
        process.exit(1);
        return;
      }
      // Everything below goes to stdout as MCP frames — keep it clean; log to stderr.
      process.stderr.write(`autodev mcp-operate → ${endpoint}\n`);

      const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };
      const rl = readline.createInterface({ input: process.stdin, terminal: false });

      // Drain in-flight requests before exiting when stdin closes, so a reply
      // in progress is never clipped.
      let inflight = 0;
      let closed = false;
      const maybeExit = (): void => { if (closed && inflight === 0) { process.exit(0); } };

      rl.on('line', async (line: string) => {
        const t = line.trim();
        if (!t) { return; }
        let req: { id?: unknown; method?: string };
        try { req = JSON.parse(t); } catch { return; }

        // Notifications (no id) are one-way — nothing to reply. Forward the
        // handshake ones opportunistically but never write a response for them.
        if (req.id === undefined || req.id === null) {
          if (typeof req.method === 'string' && req.method.startsWith('notifications/')) {
            proxy(endpoint, key, req).catch(() => { /* best effort */ });
          }
          return;
        }

        inflight++;
        try {
          send(await proxy(endpoint, key, req));
        } catch (e) {
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'proxy error: ' + ((e as Error)?.message ?? String(e)) } });
        } finally {
          inflight--;
          maybeExit();
        }
      });

      rl.on('close', () => { closed = true; maybeExit(); });
    });
}
