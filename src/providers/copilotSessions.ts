// ---------------------------------------------------------------------------
// copilotSessions — list + read GitHub Copilot CLI sessions.
//
// Copilot keeps one directory per session at
//   ~/.copilot/session-state/<uuid>/
//     workspace.yaml   → id, cwd, name, created_at/updated_at (flat scalars)
//     events.jsonl      → one JSON event per line (session.start, user.message,
//                          assistant.message, tool.execution_start/_complete, …)
//   ~/.copilot/session-store.db   (SQLite index — NOT needed for discovery)
//
// Pure filesystem — no SQLite, no yaml dependency (a tiny line scan parses the
// handful of top-level `key: value` scalars we need). Read-only; every store
// miss degrades to [] and no path ever throws.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { copilotSessionStateDir } from '../agentBackup/layout';

/** Normalise a path for comparison (absolute, no trailing slash). */
function norm(p: string): string {
  try { return path.resolve(p).replace(/\/+$/, ''); } catch { return p; }
}

/** Scan the flat top-level `key: value` scalars of a workspace.yaml. Only the
 *  first occurrence of each key is kept; quotes are stripped. Good enough for
 *  copilot's file (a flat map of scalars) without pulling in a YAML parser. */
function readWorkspaceYaml(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) { continue; }
    const key = m[1];
    if (key in out) { continue; }
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export interface CopilotSessionInfo { id: string; name: string; cwd: string; updated: number }

/** All Copilot sessions on this machine (newest first). `updated` is epoch ms
 *  from events.jsonl mtime (falls back to workspace.yaml / the folder mtime). */
export function listAllCopilotSessions(): CopilotSessionInfo[] {
  const stateDir = copilotSessionStateDir();
  let uuids: string[] = [];
  try { uuids = fs.readdirSync(stateDir); } catch { return []; }
  const out: CopilotSessionInfo[] = [];
  for (const uuid of uuids) {
    const dir = path.join(stateDir, uuid);
    try { if (!fs.statSync(dir).isDirectory()) { continue; } } catch { continue; }
    const meta = readWorkspaceYaml(path.join(dir, 'workspace.yaml'));
    const cwd = meta['cwd'] || meta['directory'] || '';
    let updated = 0;
    for (const f of ['events.jsonl', 'workspace.yaml']) {
      try { updated = Math.max(updated, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* skip */ }
    }
    if (!updated) { try { updated = fs.statSync(dir).mtimeMs; } catch { /* keep 0 */ } }
    out.push({ id: uuid, name: (meta['name'] || '').trim() || '(untitled)', cwd, updated });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** Copilot sessions whose cwd matches `root` (for per-workspace collectSessions). */
export function listCopilotSessions(root: string): Array<{ id: string; title: string; updated: number }> {
  const target = norm(root);
  return listAllCopilotSessions()
    .filter(s => s.cwd && norm(s.cwd) === target)
    .map(s => ({ id: s.id, title: s.name, updated: s.updated }));
}

export interface TranscriptMsg { role: 'user' | 'assistant' | 'system' | 'tool'; text: string; ts?: number }

function ellipsis(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Parse a copilot session's events.jsonl into a normalized message array.
 *  Renders user/assistant prose, tool calls (assistant.message.toolRequests +
 *  tool.execution_complete results) and the system prompt (heavily truncated).
 *  Returns at most `limit` messages (the tail). */
export function readCopilotTranscript(id: string, limit = 400): TranscriptMsg[] {
  const file = path.join(copilotSessionStateDir(), id, 'events.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const msgs: TranscriptMsg[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) { continue; }
    let o: Record<string, unknown>;
    try { o = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    const type = String(o['type'] ?? '');
    const data = (o['data'] ?? {}) as Record<string, unknown>;
    const ts = o['timestamp'] ? Date.parse(String(o['timestamp'])) : undefined;
    if (type === 'user.message') {
      const c = String(data['content'] ?? '').trim();
      if (c) { msgs.push({ role: 'user', text: c, ts }); }
    } else if (type === 'assistant.message') {
      const c = String(data['content'] ?? '').trim();
      if (c) { msgs.push({ role: 'assistant', text: c, ts }); }
      const reqs = data['toolRequests'];
      if (Array.isArray(reqs)) {
        for (const r of reqs as Array<Record<string, unknown>>) {
          const name = String(r['name'] ?? '');
          if (!name) { continue; }
          const args = r['arguments'] != null ? ellipsis(JSON.stringify(r['arguments']), 200) : '';
          msgs.push({ role: 'tool', text: `🔧 ${name}(${args})`, ts });
        }
      }
    } else if (type === 'tool.execution_complete') {
      const result = (data['result'] ?? {}) as Record<string, unknown>;
      const content = result['content'] ?? result['detailedContent'];
      const txt = typeof content === 'string' ? content : (content == null ? '' : JSON.stringify(content));
      if (txt.trim()) { msgs.push({ role: 'tool', text: `↳ ${ellipsis(txt.trim(), 400)}`, ts }); }
    } else if (type === 'system.message') {
      const c = String(data['content'] ?? '').trim();
      if (c) { msgs.push({ role: 'system', text: ellipsis(c, 200), ts }); }
    }
  }
  return msgs.slice(-limit);
}
