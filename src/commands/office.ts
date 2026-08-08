import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { spawn, ChildProcess } from 'child_process';
import { Command } from 'commander';
import { log } from '../logger';
import { applyWsUrl } from '../connect';

// ---------------------------------------------------------------------------
// `autodev office <slug>` — run a WHOLE office with one command.
//
// A non-technical user creates an office (with N characters) in the pixel-office
// web UI, then runs `autodev office <slug>` here. This THIN orchestration layer:
//   1. lists the office's characters via the pixel-office HTTP API,
//   2. for each character, fetches its per-agent credentials and binds a
//      dedicated workspace with the EXISTING single-agent machinery
//      (`applyWsUrl`, the same code path `autodev connect --url` uses), then
//   3. spawns the EXISTING `autodev start` loop as a child process per
//      character (the loop is a blocking singleton — one loop = one process).
//
// A lightweight watcher re-lists the office every N seconds and auto-starts any
// NEW character that appears later in the web — so agents created after launch
// just come online with no extra command. Ctrl-C stops every spawned loop.
//
// No new binding/loop logic is invented here; this is pure orchestration over
// existing pieces.
// ---------------------------------------------------------------------------

// Office rows store a provider FAMILY name ('grok'/'claude') OR a full variant.
// `autodev start -p` needs a VALID id — the bare family is rejected ("Unknown
// provider"), so normalise it. Mirrors toAutodevProvider in the desktop app
// (autodev-app/src/main/pixelOffice.ts).
const VALID_PROVIDERS = new Set([
  'claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk',
  'opencode-cli', 'opencode-sdk', 'grok-cli', 'grok-tui',
]);

function toAutodevProvider(provider?: string): string {
  const p = String(provider ?? '').trim();
  if (VALID_PROVIDERS.has(p)) { return p; }
  const l = p.toLowerCase();
  if (l.startsWith('grok'))     { return 'grok-tui'; }
  if (l.startsWith('claude'))   { return 'claude-cli'; }
  if (l.startsWith('opencode')) { return 'opencode-cli'; }
  if (l.startsWith('copilot'))  { return 'copilot-cli'; }
  return 'claude-cli';
}

interface RosterAgent {
  id: string;
  slug: string;
  name: string;
  isConnected: boolean;
  provider?: string;
}

interface CredentialsData {
  wsUrl?: string;
  slug?: string;
  apiKey?: string;
}

/** GET JSON with a `pat_` Bearer token (built-in http/https, no deps). */
function fetchJsonAuth<T>(url: string, token: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { reject(new Error(`Invalid URL: ${url}`)); return; }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'autodev-cli',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body) as T); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}: ${(e as Error).message}`)); }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Auth failed (HTTP ${res.statusCode}) — check --token. ${body.slice(0, 200)}`));
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timed out after ${timeoutMs}ms fetching ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

/** Normalise the /agents roster response (data[] | data.agents[] | agents[] | bare array). */
function normalizeRoster(json: unknown): RosterAgent[] {
  const raw = json as { data?: unknown; agents?: unknown };
  let list: unknown = [];
  if (Array.isArray(raw?.data)) { list = raw.data; }
  else if (Array.isArray((raw?.data as { agents?: unknown })?.agents)) { list = (raw.data as { agents: unknown[] }).agents; }
  else if (Array.isArray(raw?.agents)) { list = raw.agents; }
  else if (Array.isArray(json)) { list = json; }
  return (list as Record<string, unknown>[]).map((a) => ({
    id: String(a.id),
    slug: String(a.slug ?? a.id),
    name: String(a.name ?? a.slug ?? a.id),
    isConnected: Boolean(a.isConnected ?? (a as { online?: unknown }).online),
    provider: a.provider != null ? String(a.provider) : undefined,
  }));
}

/** Filesystem-safe path segment (no separators / traversal). */
function safeSeg(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent';
}

/** Prefix every line of a child's output with the character name. */
function pipePrefixed(stream: NodeJS.ReadableStream | null, name: string, sink: (line: string) => void): void {
  if (!stream) { return; }
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      sink(`[${name}] ${buf.slice(0, nl)}`);
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => { if (buf.trim()) { sink(`[${name}] ${buf}`); } });
}

export function officeCommand(program: Command): void {
  program
    .command('office <slug>')
    .description('Run a WHOLE pixel-office: bind + start every character, and auto-start new ones as they appear')
    .option('--url <baseUrl>', 'Pixel-office base URL (e.g. https://app.pixeloffice.org)', process.env.AUTODEV_SERVER_URL)
    .option('--token <token>', 'Personal-access token (pat_…) minted by the office owner', process.env.AUTODEV_OFFICE_TOKEN ?? process.env.AUTODEV_PAT)
    .option('--base-dir <dir>', 'Root folder for per-character workspaces (default: ~/.autodev/offices/<slug>)')
    .option('-p, --provider <provider>', 'Force this provider for every character (default: each agent\'s configured provider)')
    .option('--interval <seconds>', 'Watcher poll interval for new characters (default 15; 0 disables the watcher)', '15')
    .option('--no-watch', 'Do not keep watching for new characters after the initial launch')
    .action(async (slug: string, opts: {
      url?: string; token?: string; baseDir?: string; provider?: string; interval: string; watch: boolean;
    }) => {
      const base = String(opts.url ?? '').replace(/\/+$/, '');
      const token = String(opts.token ?? '');
      if (!base) { log.error('Missing office URL. Pass --url=<baseUrl> or set AUTODEV_SERVER_URL.'); process.exit(1); }
      if (!token) { log.error('Missing token. Pass --token=<pat_…> or set AUTODEV_OFFICE_TOKEN. Mint one via the pixel-office UI (POST /api/auth/tokens).'); process.exit(1); }

      const officeSlug = safeSeg(slug);
      const root = opts.baseDir
        ? path.resolve(opts.baseDir)
        : path.join(os.homedir(), '.autodev', 'offices', officeSlug);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });

      const intervalSec = Math.max(0, parseInt(opts.interval, 10) || 0);
      const watch = opts.watch && intervalSec > 0;

      // Locate the compiled CLI entry so children reliably run THIS build's
      // `autodev start` even when `autodev` is not on PATH (dev/source runs).
      // This file compiles to out/commands/office.js → cli.js is one level up.
      const cliJs = path.join(__dirname, '..', 'cli.js');

      log.section('🏢 AutoAIDev — Run the whole office');
      log.info(`Office    : ${slug}`);
      log.info(`Server    : ${base}`);
      log.info(`Workspaces: ${root}`);
      log.info(watch ? `Watcher   : every ${intervalSec}s (auto-starts new characters)` : 'Watcher   : off');
      log.plain('');

      // agentId → running child loop. Presence in this map means "we started it";
      // it gates both duplicate spawns and the block-if-already-running check.
      const children = new Map<string, { child: ChildProcess; name: string }>();
      const notedOnline = new Set<string>();
      let stopping = false;

      const startAgent = async (a: RosterAgent): Promise<void> => {
        const dir = path.join(root, safeSeg(a.slug));
        // Sandbox-escape guard: the workspace must stay under root.
        const resolved = path.resolve(dir);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          log.error(`  ${a.name}: refused workspace path outside base dir (${resolved})`);
          return;
        }
        const provider = opts.provider ? toAutodevProvider(opts.provider) : toAutodevProvider(a.provider);
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          // Fetch this character's credentials → ready-made wsUrl (token+endpoint).
          const credsRes = await fetchJsonAuth<{ success?: boolean; data?: CredentialsData; error?: string }>(
            `${base}/api/offices/${encodeURIComponent(slug)}/agents/${encodeURIComponent(a.id)}/credentials`,
            token,
          );
          const wsUrl = credsRes?.data?.wsUrl;
          if (!credsRes?.success || !wsUrl) {
            log.error(`  ${a.name}: no credentials (${credsRes?.error ?? 'missing wsUrl'})`);
            return;
          }
          // Bind the workspace with the EXISTING single-agent machinery: writes
          // .autodev/settings.json, installs hooks, wires the office MCP server,
          // grants MCP permissions AND marks the workspace Claude-trusted.
          applyWsUrl(dir, wsUrl);
        } catch (err) {
          log.error(`  ${a.name}: bind failed — ${(err as Error).message}`);
          return;
        }

        // Spawn the EXISTING start loop as its own process (blocking singleton).
        // AUTODEV_EXIT_WITH_PARENT=1 ⇒ the child reaps itself if we die.
        const child = spawn(process.execPath, [cliJs, 'start', dir, '-p', provider], {
          env: { ...process.env, AUTODEV_EXIT_WITH_PARENT: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.set(a.id, { child, name: a.name });
        log.success(`  ▶ ${a.name} (${provider}) → ${dir}`);
        pipePrefixed(child.stdout, a.name, (line) => log.plain(line));
        pipePrefixed(child.stderr, a.name, (line) => log.gray(line));
        child.on('exit', (code, sig) => {
          children.delete(a.id);
          if (!stopping) {
            log.warn(`  ⏹ ${a.name} loop exited (${sig ?? code}). It will be re-started on the next poll if still offline.`);
          }
        });
        child.on('error', (e) => {
          children.delete(a.id);
          log.error(`  ${a.name}: failed to spawn loop — ${e.message}`);
        });
      };

      const poll = async (): Promise<void> => {
        if (stopping) { return; }
        let roster: RosterAgent[];
        try {
          const json = await fetchJsonAuth<unknown>(`${base}/api/offices/${encodeURIComponent(slug)}/agents`, token);
          roster = normalizeRoster(json);
        } catch (err) {
          log.warn(`Roster fetch failed (will retry): ${(err as Error).message}`);
          return;
        }
        for (const a of roster) {
          if (children.has(a.id)) { continue; }         // we already run it
          if (a.isConnected) {                           // online elsewhere — don't flap its WS
            if (!notedOnline.has(a.id)) {
              log.gray(`  • ${a.name} already online elsewhere — skipping.`);
              notedOnline.add(a.id);
            }
            continue;
          }
          notedOnline.delete(a.id);
          await startAgent(a);
        }
      };

      // Graceful shutdown: SIGINT stops every spawned loop, then exits.
      const shutdown = (): void => {
        if (stopping) { process.exit(130); }
        stopping = true;
        log.warn(`\n⏹  Stopping ${children.size} office loop(s)…`);
        for (const { child } of children.values()) {
          try { child.kill('SIGINT'); } catch { /* ignore */ }
        }
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await poll();
      if (children.size === 0 && !watch) {
        log.warn('No characters started. Nothing to run.');
        process.exit(0);
      }
      log.gray(watch ? 'Press Ctrl+C to stop all loops. Watching for new characters…\n' : 'Press Ctrl+C to stop all loops.\n');

      if (watch) {
        const timer = setInterval(() => { void poll(); }, intervalSec * 1000);
        timer.unref?.();
        // Keep the process alive even if every child temporarily exits.
        await new Promise<never>(() => { /* runs until SIGINT */ });
      } else {
        // No watcher: stay alive while children run so SIGINT can reap them.
        await new Promise<never>(() => { /* runs until SIGINT */ });
      }
    });
}
