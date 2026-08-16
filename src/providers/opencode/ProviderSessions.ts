import { ProviderSessions } from '../base/ProviderSessions';
import type { Logger } from '../base/contract';
import type { SessionRecord, TranscriptMsg } from '../base/types';
import { listOpenCodeSessions, getLatestOpenCodeSessionId } from './cli';
import { getOpencodeSdkLatestSessionId } from './sdk';
import { getSessionClearedAt } from '../../sessionState';

export class OpencodeProviderSessions extends ProviderSessions {
  readonly family = 'opencode';

  async list(root: string): Promise<SessionRecord[]> {
    const rows = await listOpenCodeSessions(root);
    return rows.map(s => ({ id: s.id, updated: s.mtime }));
  }

  override async resolveLatest(root: string, log?: Logger): Promise<string | undefined> {
    const sdk = getOpencodeSdkLatestSessionId(root);
    if (sdk) { return sdk; }
    const clearedAt = getSessionClearedAt(root, 'opencode-cli');
    return getLatestOpenCodeSessionId(root, log ?? (() => {}), clearedAt);
  }

  readTranscript(_id: string, _opts?: { limit?: number }): TranscriptMsg[] {
    // OpenCode transcripts live in a sqlite store owned by agentBackup/opencodeDb.
    return [];
  }
}
