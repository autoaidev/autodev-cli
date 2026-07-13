import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Top-level folder inside the archive that everything lives under. */
export const TOP_FOLDER = 'agent-export';

/** Archive sub-paths, derived once from {@link TOP_FOLDER}. */
export const ARCHIVE_PATHS = {
  workspace: `${TOP_FOLDER}/workspace`,
  sessionsRoot: `${TOP_FOLDER}/sessions`,
  manifest: `${TOP_FOLDER}/manifest/session-ids.json`,
} as const;

/** Archive path for a given provider's session traces. */
export function sessionsPath(providerId: string): string {
  return `${ARCHIVE_PATHS.sessionsRoot}/${providerId}`;
}

/**
 * Root-level documents that carry agent context/protocol. Backed up and
 * restored verbatim relative to the workspace root.
 */
export const ROOT_DOCS: readonly string[] = [
  'AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'JOURNAL.md', 'CONTRACTS.md', 'TODO.md',
  'DONE.md', 'TASKS.md', 'LESSONS.md', 'NOTES.md', 'SCRATCHPAD.md',
];

/**
 * Directories under the workspace that hold agent state. Each maps a
 * workspace-relative source to the same relative location inside
 * `agent-export/workspace/`. This single list is the source of truth shared
 * by both export and import (DRY).
 */
export const WORKSPACE_DIRS: readonly string[] = [
  '.autodev',
  path.posix.join('media', 'profile'),
  path.posix.join('media', 'skills'),
];

/**
 * Identity/connection settings in `.autodev/settings.json` that are scoped to a
 * specific agent and MUST NOT travel in a backup: they are the live WS auth
 * token + endpoint. Export strips them from the shipped settings.json (a backup
 * ZIP is uploaded off-VM), and import preserves the destination agent's own
 * values so a restore never hijacks its identity. Single source of truth shared
 * by both sides (DRY).
 */
export const IDENTITY_KEYS = ['wsUrl', 'serverBaseUrl', 'serverApiKey', 'webhookSlug', 'agentId'] as const;

/** Normalise a filesystem path for comparison (case-insensitive, slash-form). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Copilot CLI store — VERIFIED on-disk layout (PLAN §2.6)
//   ~/.copilot/session-state/<uuid>/  (events.jsonl, workspace.yaml, …)
//   ~/.copilot/session-store.db       (SQLite index — not touched on restore)
// ---------------------------------------------------------------------------

/** Root of the Copilot CLI store. */
export function copilotDir(): string {
  return path.join(os.homedir(), '.copilot');
}

/** `~/.copilot/session-state` — one sub-folder per session, keyed by uuid. */
export function copilotSessionStateDir(): string {
  return path.join(copilotDir(), 'session-state');
}

// ---------------------------------------------------------------------------
// OpenCode store — VERIFIED on-disk layout (PLAN §2.6)
//   ~/.local/share/opencode/opencode.db   (SQLite — sessions + messages)
//   ~/.local/share/opencode/storage/…      (diffs/snapshots only, not a session)
// There is NO per-session directory, so per-session restore is NOT supported
// without a SQLite dependency. Kept only for discovery/diagnostics.
// ---------------------------------------------------------------------------

/** Resolve the OpenCode data directory if present (first existing wins). */
export function findOpenCodeDataDir(): string | undefined {
  const candidates: string[] = [];
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg) { candidates.push(path.join(xdg, 'opencode')); }
  candidates.push(path.join(os.homedir(), '.local', 'share', 'opencode'));
  candidates.push(path.join(os.homedir(), '.opencode'));
  const appdata = process.env['APPDATA'];
  if (appdata) { candidates.push(path.join(appdata, 'opencode')); }
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData) { candidates.push(path.join(localAppData, 'opencode')); }
  return candidates.find(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}
