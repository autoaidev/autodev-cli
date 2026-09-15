// ---------------------------------------------------------------------------
// readGrokToken — resolve the grok bearer token the SAME way the grok provider
// authenticates for its normal API calls: from the OAuth session the grok CLI
// writes to ~/.grok/auth.json (GROK_HOME override honored, matching sessions.ts).
//
// auth.json maps "<oidc-issuer>::<id>" → { key, refresh_token, create_time, … }
// where `key` is the access token. We pick the freshest entry that carries a key.
// Env XAI_API_KEY / GROK_API_KEY take precedence (CI / office-supplied tokens).
//
// The token is NEVER logged. Returns null when none is available, so callers
// fall back to the static model list.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function grokHome(): string {
  return process.env['GROK_HOME'] || path.join(os.homedir(), '.grok');
}

export function readGrokToken(): string | null {
  const env = (process.env['XAI_API_KEY'] || process.env['GROK_API_KEY'] || '').trim();
  if (env) return env;

  try {
    const raw = fs.readFileSync(path.join(grokHome(), 'auth.json'), 'utf8');
    const json: unknown = JSON.parse(raw);
    if (json && typeof json === 'object') {
      let best: { key: string; t: number } | null = null;
      for (const v of Object.values(json as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          const o = v as { key?: unknown; create_time?: unknown };
          const key = typeof o.key === 'string' ? o.key.trim() : '';
          if (key) {
            const t = Date.parse(String(o.create_time ?? '')) || 0;
            if (!best || t > best.t) best = { key, t };
          }
        }
      }
      if (best) return best.key;
    }
  } catch {
    // No auth.json / unreadable / malformed → no token.
  }
  return null;
}
