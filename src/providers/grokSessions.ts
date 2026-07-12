// ---------------------------------------------------------------------------
// grokSessions — list grok's own conversation sessions for a workspace.
//
// Grok keeps a per-workspace session index at
//   ~/.grok/sessions/session_search.sqlite  →  table session_docs
//     (session_id, cwd, updated_at [epoch SECONDS], title, …)
//
// Reads it with the built-in `node:sqlite` (Node 22) — same approach as the
// opencode reader, so no new dependency. Read-only; returns [] if the store
// isn't present (grok never run) or can't be opened.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function grokSessionsDbPath(): string {
  const base = process.env['GROK_HOME'] || path.join(os.homedir(), '.grok');
  return path.join(base, 'sessions', 'session_search.sqlite');
}

/** Normalise a path for comparison (absolute, no trailing slash). */
function norm(p: string): string {
  try { return path.resolve(p).replace(/\/+$/, ''); } catch { return p; }
}

interface GrokSessionRow { session_id: unknown; title: unknown; updated_at: unknown; cwd: unknown }

/** Sessions grok has stored for `root`, newest first. `updated` is epoch ms. */
export function listGrokSessions(root: string): Array<{ id: string; title: string; updated: number }> {
  const dbFile = grokSessionsDbPath();
  if (!fs.existsSync(dbFile)) { return []; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
    const target = norm(root);
    return (db.prepare('SELECT session_id, title, updated_at, cwd FROM session_docs').all() as GrokSessionRow[])
      .filter(r => norm(String(r.cwd ?? '')) === target)
      .map(r => ({
        id: String(r.session_id),
        title: String(r.title ?? '').trim(),
        updated: Number(r.updated_at ?? 0) * 1000, // grok stores seconds → ms
      }))
      .sort((a, b) => b.updated - a.updated);
  } catch { return []; } finally { try { db?.close(); } catch { /* ignore */ } }
}
