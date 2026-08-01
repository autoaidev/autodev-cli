// ---------------------------------------------------------------------------
// Global (cross-workspace) session discovery + transcript reading across ALL
// providers (claude, grok, opencode, copilot). Unlike collectSessions() — which
// is scoped to one workspace root — this surfaces every session on the machine
// with its own cwd, so a UI (the autodev-app Sessions tab) can list and read
// them regardless of where they were started. Single source of truth: the app
// shells to `autodev sessions --all --json` and `autodev session-show`.
//
// Read-only and resilient: any missing store degrades to []; nothing throws.
// ---------------------------------------------------------------------------

import { listAllClaudeSessions, readClaudeTranscript } from './providers/claudeCliProvider';
import { listAllGrokSessions, readGrokTranscript } from './providers/grokSessions';
import { listAllOpenCodeSessions, readOpenCodeTranscript } from './agentBackup/opencodeDb';
import { listAllCopilotSessions, readCopilotTranscript } from './providers/copilotSessions';

/** A provider family for global session discovery. */
export type SessionProvider = 'claude' | 'grok' | 'opencode' | 'copilot';

/** Normalized cross-provider session descriptor. `updated` is epoch ms. */
export interface GlobalSession {
  provider: SessionProvider;
  id: string;
  name: string;
  cwd: string;
  updated: number;
  file?: string; // claude: the transcript path (used for the app's live-tail)
  msgs?: number; // best-effort message count where cheaply known
}

/** Normalized transcript message. */
export interface SessionMsg {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts?: number;
}

/** Map a `--provider` family string onto a canonical SessionProvider, or
 *  undefined for "all". Accepts the fine-grained ids too (grok-tui → grok). */
export function normalizeSessionProvider(p?: string): SessionProvider | undefined {
  if (!p) { return undefined; }
  const s = p.toLowerCase();
  if (s.startsWith('claude')) { return 'claude'; }
  if (s.startsWith('grok')) { return 'grok'; }
  if (s.startsWith('opencode')) { return 'opencode'; }
  if (s.startsWith('copilot')) { return 'copilot'; }
  return undefined;
}

/** List sessions across ALL workspaces for every provider (or one family when
 *  `provider` is given), newest first. */
export function collectAllSessions(provider?: SessionProvider): GlobalSession[] {
  const out: GlobalSession[] = [];
  const want = (p: SessionProvider): boolean => !provider || provider === p;

  if (want('claude')) {
    for (const s of listAllClaudeSessions()) {
      out.push({ provider: 'claude', id: s.id, name: s.name, cwd: s.cwd, updated: s.updated, file: s.file, msgs: s.msgs });
    }
  }
  if (want('grok')) {
    for (const s of listAllGrokSessions()) {
      out.push({ provider: 'grok', id: s.id, name: s.title || '(untitled)', cwd: s.cwd, updated: s.updated });
    }
  }
  if (want('opencode')) {
    for (const s of listAllOpenCodeSessions()) {
      out.push({ provider: 'opencode', id: s.id, name: s.title || '(untitled)', cwd: s.cwd, updated: s.updated });
    }
  }
  if (want('copilot')) {
    for (const s of listAllCopilotSessions()) {
      out.push({ provider: 'copilot', id: s.id, name: s.name, cwd: s.cwd, updated: s.updated });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** Read a session's transcript as a normalized message array. `file`/`cwd` are
 *  optional hints that let claude/grok resolve the store faster. Capped at
 *  `limit` (default 400) messages. */
export function readSessionTranscript(
  provider: SessionProvider,
  id: string,
  opts: { file?: string; cwd?: string; limit?: number } = {},
): SessionMsg[] {
  const limit = opts.limit ?? 400;
  switch (provider) {
    case 'claude':   return readClaudeTranscript(id, opts.file, limit);
    case 'grok':     return readGrokTranscript(id, opts.cwd, limit);
    case 'opencode': return readOpenCodeTranscript(id, limit);
    case 'copilot':  return readCopilotTranscript(id, limit);
    default:         return [];
  }
}
