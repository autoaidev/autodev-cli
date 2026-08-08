import * as http from 'http';
import * as https from 'https';
import * as readline from 'readline';
import { URL } from 'url';
import { Command } from 'commander';
import { log } from '../logger';
import { DEFAULT_BASE_URL, loadUserConfig, saveUserConfig } from '../core/userConfig';
import { preflight } from '../core/officeAuth';

// ---------------------------------------------------------------------------
// `autodev login` — authenticate to a pixel-office server ONCE and store a
// `pat_` personal-access token in ~/.autodev/config.json so `autodev office`
// needs no --url/--token afterwards.
//
// Two ways in (see [[pixel-office-api-auth]]):
//   (a) email + password → cookie dance (GET /api/csrf-token → POST
//       /api/auth/login) → POST /api/auth/tokens mints a pat_.
//   (b) --token pat_…    → just store a pasted one.
//
// The token is NEVER printed. On success we run the same green/red preflight
// `autodev office` uses.
// ---------------------------------------------------------------------------

interface HttpResult { status: number; headers: http.IncomingHttpHeaders; body: string; }

/** Raw request with a cookie jar + JSON body (built-in http/https, no deps). */
function request(
  urlStr: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(urlStr); }
    catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(urlStr, {
      method: opts.method ?? 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'autodev-cli', ...opts.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(opts.timeoutMs ?? 15_000, () => { req.destroy(new Error(`Timed out fetching ${urlStr}`)); });
    req.on('error', reject);
    if (opts.body) { req.write(opts.body); }
    req.end();
  });
}

/** Fold set-cookie headers into a name→value jar. */
function absorbCookies(jar: Map<string, string>, res: HttpResult): void {
  const raw = res.headers['set-cookie'];
  if (!raw) { return; }
  for (const line of Array.isArray(raw) ? raw : [raw]) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) { jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()); }
  }
}

const cookieHeader = (jar: Map<string, string>): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

/** Laravel expects the X-XSRF-TOKEN header to be the URL-DECODED cookie value. */
function xsrf(jar: Map<string, string>): string {
  const c = jar.get('XSRF-TOKEN');
  if (!c) { return ''; }
  try { return decodeURIComponent(c); } catch { return c; }
}

/** Prompt for a line on the TTY (visible). */
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Prompt for a secret without echoing it to the terminal. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Mute echo: swallow everything except the prompt itself.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) { process.stdout.write(question); }
    };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

/** Cookie-dance login → mint and return a pat_ personal-access token. */
async function mintToken(base: string, email: string, password: string, name: string): Promise<string> {
  const jar = new Map<string, string>();

  // 1. Prime the CSRF cookie.
  const csrfRes = await request(`${base}/api/csrf-token`, { headers: {} });
  absorbCookies(jar, csrfRes);
  if (!jar.get('XSRF-TOKEN')) {
    throw new Error(`Could not obtain a CSRF token from ${base} (HTTP ${csrfRes.status}). Is --url correct?`);
  }

  // 2. Log in (session lives in the cookie jar; no token returned here).
  const loginRes = await request(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': xsrf(jar),
      'Cookie': cookieHeader(jar),
    },
    body: JSON.stringify({ email, password }),
  });
  absorbCookies(jar, loginRes);
  if (loginRes.status === 401 || loginRes.status === 422) {
    throw new Error('Login failed — check your email and password.');
  }
  if (loginRes.status < 200 || loginRes.status >= 300) {
    throw new Error(`Login failed (HTTP ${loginRes.status}): ${loginRes.body.slice(0, 200)}`);
  }

  // 3. Mint a personal-access token (Bearer pat_…), shown once.
  const tokRes = await request(`${base}/api/auth/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': xsrf(jar),
      'Cookie': cookieHeader(jar),
    },
    body: JSON.stringify({ name }),
  });
  if (tokRes.status < 200 || tokRes.status >= 300) {
    throw new Error(`Could not mint a token (HTTP ${tokRes.status}): ${tokRes.body.slice(0, 200)}`);
  }
  let token: string | undefined;
  try {
    const j = JSON.parse(tokRes.body) as { data?: { token?: string }; token?: string };
    token = j?.data?.token ?? j?.token;
  } catch { /* fall through to the missing-token error */ }
  if (!token) { throw new Error('Token endpoint returned no token.'); }
  return token;
}

export function loginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate to a pixel-office server and store a token so `autodev office` needs no --url/--token')
    .option('--url <baseUrl>', 'Pixel-office base URL', process.env.AUTODEV_SERVER_URL)
    .option('--email <email>', 'Account email (else prompted)')
    .option('--password <password>', 'Account password (else prompted, hidden)')
    .option('--token <pat_…>', 'Store a pasted personal-access token instead of email/password')
    .option('--name <name>', 'Name for the minted token', 'autodev-cli')
    .action(async (opts: { url?: string; email?: string; password?: string; token?: string; name: string }) => {
      const stored = loadUserConfig();
      let base = String(opts.url ?? stored.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      if (!opts.url && !stored.baseUrl && process.stdin.isTTY) {
        const typed = (await ask(`Pixel-office URL [${DEFAULT_BASE_URL}]: `)).replace(/\/+$/, '');
        if (typed) { base = typed; }
      }

      log.section('🔐 AutoAIDev — Login');
      log.info(`Server: ${base}`);

      let token: string;
      try {
        if (opts.token) {
          token = String(opts.token).trim();
          if (!token) { throw new Error('Empty --token.'); }
        } else {
          let email = opts.email;
          let password = opts.password;
          if (!email) {
            if (!process.stdin.isTTY) { throw new Error('No --email given and no TTY to prompt. Pass --email/--password or --token.'); }
            email = await ask('Email: ');
          }
          if (!password) {
            if (!process.stdin.isTTY) { throw new Error('No --password given and no TTY to prompt. Pass --password or --token.'); }
            password = await askHidden('Password: ');
          }
          if (!email || !password) { throw new Error('Email and password are required.'); }
          token = await mintToken(base, email, password, opts.name);
        }
      } catch (err) {
        log.error(`✗ ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      // Preflight BEFORE persisting: don't store a token we can't use.
      const pf = await preflight(base, token);
      if (!pf.ok) {
        log.error(`✗ ${pf.reason} — check --url and credentials.`);
        process.exit(1);
        return;
      }

      // Never print the token.
      saveUserConfig({ baseUrl: base, token });
      const who = pf.who ? `as ${pf.who} ` : '';
      const nOffices = typeof pf.offices === 'number' ? `· ${pf.offices} office${pf.offices === 1 ? '' : 's'}` : '';
      log.success(`✓ connected ${who}${nOffices}`.trim());
      log.gray('  saved to: ~/.autodev/config.json');
      log.gray('  next: autodev office <slug>');
    });
}
