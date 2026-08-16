import { ProviderSessions } from '../base/ProviderSessions';
import type { SessionRecord, TranscriptMsg } from '../base/types';
import { listGrokSessions, listAllGrokSessions, readGrokTranscript } from './sessions';
import { getSessionId } from '../../sessionState';

export class GrokProviderSessions extends ProviderSessions {
  readonly family = 'grok';

  list(root: string): SessionRecord[] {
    return listGrokSessions(root).map(s => ({
      id: s.id, name: s.title, updated: s.updated,
    }));
  }

  listAll(): SessionRecord[] {
    return listAllGrokSessions().map(s => ({
      id: s.id, name: s.title, cwd: s.cwd, updated: s.updated,
    }));
  }

  override async resolveLatest(root: string): Promise<string | undefined> {
    return getSessionId(root, 'grok-tui') ?? this.list(root)[0]?.id;
  }

  readTranscript(id: string, opts?: { cwd?: string; limit?: number }): TranscriptMsg[] {
    return readGrokTranscript(id, opts?.cwd, opts?.limit ?? 400);
  }
}
