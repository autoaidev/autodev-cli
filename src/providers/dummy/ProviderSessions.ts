import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ProviderSessions } from '../base/ProviderSessions';
import type { SessionRecord, TranscriptMsg } from '../base/types';

function storeDir(root: string): string {
  return path.join(root, '.autodev', 'dummy', 'sessions');
}

export class DummyProviderSessions extends ProviderSessions {
  readonly family = 'dummy';

  list(root: string): SessionRecord[] {
    const dir = storeDir(root);
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          let name = '(untitled)';
          try { name = (JSON.parse(fs.readFileSync(full, 'utf8')) as { name?: string }).name || name; } catch { /* */ }
          return { id: f.replace(/\.json$/, ''), name, cwd: root, updated: st.mtimeMs };
        })
        .sort((a, b) => b.updated - a.updated);
    } catch { return []; }
  }

  create(root: string, name = 'dummy-session'): SessionRecord {
    const dir = storeDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const rec = { id, name, cwd: root, updated: Date.now(), msgs: [] as TranscriptMsg[] };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 2), 'utf8');
    return { id, name, cwd: root, updated: rec.updated };
  }

  appendMessages(root: string, id: string, msgs: TranscriptMsg[]): void {
    const file = path.join(storeDir(root), `${id}.json`);
    let rec: { id: string; name: string; cwd: string; updated: number; msgs: TranscriptMsg[] };
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { rec = { id, name: 'dummy-session', cwd: root, updated: Date.now(), msgs: [] }; }
    rec.msgs = [...(rec.msgs ?? []), ...msgs];
    rec.updated = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  }

  readTranscript(id: string, opts?: { cwd?: string; limit?: number }): TranscriptMsg[] {
    const root = opts?.cwd;
    if (!root) { return []; }
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(storeDir(root), `${id}.json`), 'utf8')) as { msgs?: TranscriptMsg[] };
      const msgs = rec.msgs ?? [];
      return msgs.slice(-(opts?.limit ?? 400));
    } catch { return []; }
  }
}
