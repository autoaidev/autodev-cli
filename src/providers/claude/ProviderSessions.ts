import { ProviderSessions } from '../base/ProviderSessions';
import type { Logger } from '../base/contract';
import type { SessionRecord, TranscriptMsg } from '../base/types';
import {
  listClaudeSessions,
  listAllClaudeSessions,
  readClaudeTranscript,
  findLatestClaudeSession,
  getClaudeSessionDisplay,
  probeClaudeSession,
} from './cli';

export class ClaudeProviderSessions extends ProviderSessions {
  readonly family = 'claude';

  list(root: string): SessionRecord[] {
    return listClaudeSessions(root).map(s => ({
      id: s.id,
      name: getClaudeSessionDisplay(s.id) || '(untitled)',
      updated: s.mtime,
    }));
  }

  listAll(): SessionRecord[] {
    return listAllClaudeSessions().map(s => ({
      id: s.id, name: s.name, cwd: s.cwd, updated: s.updated, file: s.file, msgs: s.msgs,
    }));
  }

  override async resolveLatest(root: string, log?: Logger): Promise<string | undefined> {
    const latest = findLatestClaudeSession(root);
    if (latest) { return latest; }
    if (log) { return probeClaudeSession(root, log); }
    return undefined;
  }

  readTranscript(id: string, opts?: { cwd?: string; file?: string; limit?: number }): TranscriptMsg[] {
    return readClaudeTranscript(id, opts?.file, opts?.limit ?? 400);
  }
}
