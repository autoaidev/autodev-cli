// ---------------------------------------------------------------------------
// OpenCode session portability — dump/restore the rows that make up a session
// from opencode's shared SQLite store (~/.local/share/opencode/opencode.db).
//
// A session spans 5 tables: project → workspace → session → message → part.
// On restore we rewrite the directory/worktree to the destination root and
// INSERT OR REPLACE the rows (parents first) into the destination DB so
// `opencode session list` finds the session under the new path and resume works.
//
// Uses the built-in `node:sqlite` (experimental but present in Node 22) so no
// new dependency is required. Loaded lazily — agentBackup still works if it's
// unavailable (opencode just falls back to non-portable).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Row = Record<string, unknown>;

export interface OpenCodeDump {
  sessions: Row[];
  projects: Row[];
  workspaces: Row[];
  messages: Row[];
  parts: Row[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDb(file: string, readOnly: boolean): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly });
}

export function opencodeDbPath(): string {
  const base = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

function norm(p: string): string {
  let r = p;
  try { r = fs.realpathSync(p); } catch { /* keep lexical */ }
  return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const TABLES = ['session', 'project', 'workspace', 'message', 'part'] as const;

/** Dump every row that belongs to the session(s) rooted at `root`, or null. */
export function dumpOpenCodeSessions(root: string): OpenCodeDump | null {
  const dbFile = opencodeDbPath();
  if (!fs.existsSync(dbFile)) { return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    db = openDb(dbFile, true);
    const target = norm(root);
    const sessions = (db.prepare('SELECT * FROM session').all() as Row[])
      .filter(s => norm(String(s.directory)) === target);
    if (sessions.length === 0) { return null; }
    const ids = (arr: unknown[]) => [...new Set(arr.filter(Boolean).map(String))];
    const sids = ids(sessions.map(s => s.id));
    const projIds = ids(sessions.map(s => s.project_id));
    const wsIds = ids(sessions.map(s => s.workspace_id));
    const inq = (a: string[]) => a.map(() => '?').join(',');
    const sel = (sql: string, params: string[]): Row[] =>
      params.length ? (db.prepare(sql).all(...params) as Row[]) : [];
    return {
      sessions,
      projects:   sel(`SELECT * FROM project   WHERE id IN (${inq(projIds)})`, projIds),
      workspaces: sel(`SELECT * FROM workspace WHERE id IN (${inq(wsIds)})`, wsIds),
      messages:   sel(`SELECT * FROM message   WHERE session_id IN (${inq(sids)})`, sids),
      parts:      sel(`SELECT * FROM part      WHERE session_id IN (${inq(sids)})`, sids),
    };
  } catch { return null; } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** Insert a dump into the destination DB, rewriting paths to `destRoot`. */
export function restoreOpenCodeSessions(destRoot: string, dump: OpenCodeDump): number {
  const dbFile = opencodeDbPath();
  // Requires opencode to have initialised its schema on this machine at least
  // once. Without the DB we can't insert (no tables) — caller treats 0 as skip.
  if (!fs.existsSync(dbFile)) { return 0; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any; let written = 0;
  try {
    db = openDb(dbFile, false);
    for (const s of dump.sessions)  { s.directory = destRoot; }
    for (const p of dump.projects)  { p.worktree = destRoot; }
    for (const w of dump.workspaces) { if (w.directory != null) { w.directory = destRoot; } }
    const insert = (table: string, rows: Row[]): void => {
      for (const row of rows) {
        const cols = Object.keys(row);
        const sql = `INSERT OR REPLACE INTO ${table} (${cols.map(c => '`' + c + '`').join(',')}) `
          + `VALUES (${cols.map(() => '?').join(',')})`;
        try {
          db.prepare(sql).run(...cols.map(c => normValue(row[c])));
          written++;
        } catch { /* skip a bad row, keep going */ }
      }
    };
    try { db.exec('PRAGMA foreign_keys=OFF'); } catch { /* ignore */ }
    // Parents first to satisfy FKs even with enforcement on.
    insert('project', dump.projects);
    insert('workspace', dump.workspaces);
    insert('session', dump.sessions);
    insert('message', dump.messages);
    insert('part', dump.parts);
    return written;
  } catch { return written; } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** node:sqlite only binds null|number|bigint|string|Uint8Array. */
function normValue(v: unknown): string | number | bigint | null | Uint8Array {
  if (v === null || v === undefined) { return null; }
  if (typeof v === 'boolean') { return v ? 1 : 0; }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) { return v; }
  return JSON.stringify(v);
}

void TABLES;
