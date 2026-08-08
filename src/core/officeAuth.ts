import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Shared pixel-office admin-API helpers (no deps): an authed GET and a cheap
// green/red preflight used by both `autodev login` and `autodev office`.
// ---------------------------------------------------------------------------

/** GET JSON with a `pat_` Bearer token (built-in http/https, no deps). */
export function fetchJsonAuth<T>(url: string, token: string, timeoutMs = 15_000): Promise<T> {
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
          reject(new Error(`Auth failed (HTTP ${res.statusCode}) — token invalid or expired. ${body.slice(0, 200)}`));
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

/** Count offices from the assorted shapes /api/offices can return. */
function countOffices(json: unknown): number | undefined {
  const raw = json as { data?: unknown; offices?: unknown };
  let list: unknown;
  if (Array.isArray(raw?.data)) { list = raw.data; }
  else if (Array.isArray((raw?.data as { offices?: unknown })?.offices)) { list = (raw.data as { offices: unknown[] }).offices; }
  else if (Array.isArray(raw?.offices)) { list = raw.offices; }
  else if (Array.isArray(json)) { list = json; }
  return Array.isArray(list) ? list.length : undefined;
}

/** Best-effort human identity from a /api/user-style payload. */
function pickWho(json: unknown): string | undefined {
  const u = (json as { data?: Record<string, unknown> })?.data ?? (json as Record<string, unknown>);
  if (!u || typeof u !== 'object') { return undefined; }
  const name = (u as { name?: unknown }).name;
  const email = (u as { email?: unknown }).email;
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return s(name) ?? s(email);
}

export interface PreflightResult {
  ok: boolean;
  /** Who we're authenticated as (best-effort). */
  who?: string;
  /** Office count on success. */
  offices?: number;
  /** Human reason on failure. */
  reason?: string;
}

/**
 * Cheap authed check that the server is reachable and the token is valid.
 * The hard gate is GET /api/offices (401/403/network ⇒ not ok). The signed-in
 * identity is a best-effort GET /api/user — its absence never fails preflight.
 */
export async function preflight(baseUrl: string, token: string, timeoutMs = 12_000): Promise<PreflightResult> {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) { return { ok: false, reason: 'no server URL configured' }; }
  if (!token) { return { ok: false, reason: 'no token configured' }; }

  let offices: number | undefined;
  try {
    const json = await fetchJsonAuth<unknown>(`${base}/api/offices`, token, timeoutMs);
    offices = countOffices(json);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let who: string | undefined;
  try {
    who = pickWho(await fetchJsonAuth<unknown>(`${base}/api/user`, token, 8_000));
  } catch { /* identity is best-effort */ }

  return { ok: true, who, offices };
}
