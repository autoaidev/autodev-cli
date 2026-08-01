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

/** ALL grok sessions across every workspace (newest first), carrying each row's
 *  own cwd. Same store as {@link listGrokSessions} but unfiltered — for global
 *  cross-workspace discovery. `updated` is epoch ms. */
export function listAllGrokSessions(): Array<{ id: string; title: string; updated: number; cwd: string }> {
  const dbFile = grokSessionsDbPath();
  if (!fs.existsSync(dbFile)) { return []; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
    return (db.prepare('SELECT session_id, title, updated_at, cwd FROM session_docs').all() as GrokSessionRow[])
      .map(r => ({
        id: String(r.session_id),
        title: String(r.title ?? '').trim(),
        updated: Number(r.updated_at ?? 0) * 1000, // grok stores seconds → ms
        cwd: String(r.cwd ?? ''),
      }))
      .sort((a, b) => b.updated - a.updated);
  } catch { return []; } finally { try { db?.close(); } catch { /* ignore */ } }
}

export interface TranscriptMsg { role: 'user' | 'assistant' | 'system' | 'tool'; text: string; ts?: number }

/** Path to grok's clean structured transcript for a session under a given cwd. */
function grokChatHistoryPath(cwd: string, sessionId: string): string {
  const base = process.env['GROK_HOME'] || path.join(os.homedir(), '.grok');
  return path.join(base, 'sessions', encodeURIComponent(cwd), sessionId, 'chat_history.jsonl');
}

/** Resolve a session's chat_history.jsonl. If `cwd` is unknown, look the cwd up
 *  in the session index, then fall back to scanning every workspace folder. */
function resolveGrokChatHistory(sessionId: string, cwd?: string): string | undefined {
  if (cwd) {
    const p = grokChatHistoryPath(cwd, sessionId);
    if (fs.existsSync(p)) { return p; }
  }
  const known = listAllGrokSessions().find(s => s.id === sessionId)?.cwd;
  if (known) {
    const p = grokChatHistoryPath(known, sessionId);
    if (fs.existsSync(p)) { return p; }
  }
  // Last resort: scan the per-workspace session folders for a matching id.
  try {
    const base = process.env['GROK_HOME'] || path.join(os.homedir(), '.grok');
    const sessRoot = path.join(base, 'sessions');
    for (const enc of fs.readdirSync(sessRoot)) {
      const p = path.join(sessRoot, enc, sessionId, 'chat_history.jsonl');
      if (fs.existsSync(p)) { return p; }
    }
  } catch { /* none */ }
  return undefined;
}

/**
 * Read a grok session's clean chat_history.jsonl into a normalized message
 * array. Each line is {type|role, content, tool_calls?, tool_call_id?}. Renders
 * user/assistant/system prose, assistant tool_calls, and tool_result output.
 * Returns at most `limit` messages (the tail). Read-only; [] on any miss.
 */
export function readGrokTranscript(sessionId: string, cwd?: string, limit = 400): TranscriptMsg[] {
  const file = resolveGrokChatHistory(sessionId, cwd);
  if (!file) { return []; }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const trunc = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s);
  // grok content is either a plain string or an array of {type:'text',text} blocks.
  const extract = (c: unknown): string => {
    if (typeof c === 'string') { return c; }
    if (Array.isArray(c)) {
      return (c as Array<Record<string, unknown>>)
        .map(b => (b && b['type'] === 'text' ? String(b['text'] ?? '') : ''))
        .filter(Boolean).join('\n');
    }
    return c == null ? '' : JSON.stringify(c);
  };
  const msgs: TranscriptMsg[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) { continue; }
    let o: { type?: string; role?: string; content?: unknown; tool_calls?: Array<{ name?: string; arguments?: string }> };
    try { o = JSON.parse(s); } catch { continue; }
    const kind = o.type || o.role;
    const content = extract(o.content);
    if (kind === 'user') {
      if (content.trim()) { msgs.push({ role: 'user', text: content.trim() }); }
    } else if (kind === 'assistant') {
      if (content.trim()) { msgs.push({ role: 'assistant', text: content.trim() }); }
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          const name = (tc?.name || '').trim();
          if (!name) { continue; }
          const args = tc?.arguments ? trunc(String(tc.arguments), 200) : '';
          msgs.push({ role: 'tool', text: `🔧 ${name}(${args})` });
        }
      }
    } else if (kind === 'tool_result') {
      if (content.trim()) { msgs.push({ role: 'tool', text: `↳ ${trunc(content.trim(), 400)}` }); }
    } else if (kind === 'system') {
      if (content.trim()) { msgs.push({ role: 'system', text: trunc(content.trim(), 200) }); }
    }
    // 'reasoning' records are intentionally skipped (internal chain-of-thought).
  }
  return msgs.slice(-limit);
}
