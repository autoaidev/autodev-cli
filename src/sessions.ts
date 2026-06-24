// ---------------------------------------------------------------------------
// Cross-provider session listing for a workspace — surfaces existing sessions
// (id + display name/title + last-updated) so UIs (CLI, app) can show and
// resume them. Provider-aware; honest about which stores are inspectable.
// ---------------------------------------------------------------------------
import { listClaudeSessions, getClaudeSessionDisplay } from './providers/claudeCliProvider';
import { listOpenCodeSessionsDetailed } from './agentBackup/opencodeDb';
import { loadSettingsForRoot } from './core/settingsLoader';
import { ProviderId } from './providers';

export interface SessionInfo {
  provider: 'claude' | 'opencode' | string;
  id: string;
  name: string;
  updated: number; // epoch ms
  active?: boolean; // currently the resumed session in settings/session-state
}

/** List sessions for a workspace. If `provider` is omitted, infer the family
 *  from settings and include claude + opencode (the inspectable stores). */
export function collectSessions(root: string, provider?: ProviderId): SessionInfo[] {
  const settings = loadSettingsForRoot(root);
  const fam = (provider ?? settings.provider ?? 'claude-cli');
  const out: SessionInfo[] = [];

  const wantClaude = fam.startsWith('claude') || !provider;
  const wantOpencode = fam.startsWith('opencode') || !provider;

  if (wantClaude) {
    for (const s of listClaudeSessions(root)) {
      out.push({ provider: 'claude', id: s.id, name: getClaudeSessionDisplay(s.id) || '(untitled)', updated: s.mtime });
    }
  }
  if (wantOpencode) {
    for (const s of listOpenCodeSessionsDetailed(root)) {
      out.push({ provider: 'opencode', id: s.id, name: s.title || '(untitled)', updated: s.updated });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}
