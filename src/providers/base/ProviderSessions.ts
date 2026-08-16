// ---------------------------------------------------------------------------
// ProviderSessions — list / read / resolve conversation sessions.
// ---------------------------------------------------------------------------

import type { Logger } from './contract';
import type { SessionRecord, TranscriptMsg } from './types';

export abstract class ProviderSessions {
  abstract readonly family: string;

  /** Sessions for one workspace, newest first. */
  abstract list(root: string): SessionRecord[] | Promise<SessionRecord[]>;

  /** Latest session id for `root`, or undefined when none exist. */
  async resolveLatest(root: string, _log?: Logger): Promise<string | undefined> {
    const all = await this.list(root);
    return all[0]?.id;
  }

  /** Read a transcript by id into a normalized message array. */
  abstract readTranscript(id: string, opts?: { cwd?: string; file?: string; limit?: number }): TranscriptMsg[];
}
