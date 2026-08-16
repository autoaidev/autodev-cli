import { ProviderSessions } from '../base/ProviderSessions';
import type { Logger } from '../base/contract';
import type { SessionRecord, TranscriptMsg } from '../base/types';
import { listCopilotSessions, listAllCopilotSessions, readCopilotTranscript } from './sessions';
import { probeCopilotSession } from './cli';
import { getLatestCopilotSdkSessionId } from './sdk';

export class CopilotProviderSessions extends ProviderSessions {
  readonly family = 'copilot';

  list(root: string): SessionRecord[] {
    return listCopilotSessions(root).map(s => ({
      id: s.id, name: s.title, updated: s.updated,
    }));
  }

  listAll(): SessionRecord[] {
    return listAllCopilotSessions().map(s => ({
      id: s.id, name: s.name, cwd: s.cwd, updated: s.updated,
    }));
  }

  override async resolveLatest(root: string, log?: Logger): Promise<string | undefined> {
    const listed = this.list(root)[0]?.id;
    if (listed) { return listed; }
    const sdk = getLatestCopilotSdkSessionId(root);
    if (sdk) { return sdk; }
    if (log) { return probeCopilotSession(root, log); }
    return undefined;
  }

  readTranscript(id: string, opts?: { limit?: number }): TranscriptMsg[] {
    return readCopilotTranscript(id, opts?.limit ?? 400);
  }
}
