import * as fs from 'fs';
import * as path from 'path';
import { AdmZipArchive } from './archive';
import { ARCHIVE_PATHS, TOP_FOLDER } from './layout';
import { SESSION_BACKUP_PROVIDERS } from './sessionProviders';
import { parseManifest } from './manifest';

/**
 * Identity/connection settings that belong to the DESTINATION agent, not the
 * backed-up one. Restoring a backup must never overwrite these, or the restored
 * agent would connect as the source agent (identity hijack).
 */
const IDENTITY_KEYS = ['wsUrl', 'serverBaseUrl', 'serverApiKey', 'webhookSlug', 'agentId'] as const;

export interface ImportResult {
  destRoot: string;
  workspaceFiles: number;
  /** Provider id → number of session-trace files restored. */
  restoredByProvider: Record<string, number>;
  manifestRestored: boolean;
}

/**
 * Restore an agent backup ZIP into a destination folder and wire up its
 * session state so it resumes there. Mirrors {@link './export'} using the
 * same shared layout (DRY).
 *
 * The workspace `.autodev/` (including `session-state.json`) is restored
 * verbatim, so connected session IDs travel automatically — the per-provider
 * `restore()` calls place the matching traces into each host store.
 */
export async function restoreAgentBackup(zipPath: string, destRoot: string): Promise<ImportResult> {
  const archive = AdmZipArchive.open(zipPath);

  // Reject archives that aren't an agent backup.
  if (!archive.entryPaths().some(p => p.startsWith(`${TOP_FOLDER}/`))) {
    throw new Error('Not an AutoDev agent backup (missing agent-export/ root).');
  }

  // Preserve THIS agent's identity/connection settings across the restore —
  // the backup carries the source agent's settings.json (wsUrl/api_key/slug),
  // which would otherwise hijack this agent's identity.
  const destSettingsPath = path.join(destRoot, '.autodev', 'settings.json');
  const preservedIdentity: Record<string, unknown> = {};
  try {
    if (fs.existsSync(destSettingsPath)) {
      const cur = JSON.parse(fs.readFileSync(destSettingsPath, 'utf8')) as Record<string, unknown>;
      for (const k of IDENTITY_KEYS) { if (cur[k] !== undefined) { preservedIdentity[k] = cur[k]; } }
    }
  } catch { /* no current settings — nothing to preserve */ }

  // 1. Workspace state + root docs back into the destination folder.
  const workspaceFiles = archive.extractDir(ARCHIVE_PATHS.workspace, destRoot);

  // Re-apply the preserved identity onto the restored settings.json.
  if (Object.keys(preservedIdentity).length > 0) {
    try {
      const restored = fs.existsSync(destSettingsPath)
        ? (JSON.parse(fs.readFileSync(destSettingsPath, 'utf8')) as Record<string, unknown>)
        : {};
      Object.assign(restored, preservedIdentity);
      fs.mkdirSync(path.dirname(destSettingsPath), { recursive: true });
      fs.writeFileSync(destSettingsPath, JSON.stringify(restored, null, 2) + '\n', 'utf8');
    } catch { /* best effort */ }
  }

  // Start a FRESH provider session. The backup's session-state.json points at the
  // SOURCE agent's live session — resuming it would leak that agent's conversation
  // into this one and kick off a phantom "working" turn. Restore recovers the
  // workspace files; the session starts clean.
  try {
    const sessionState = path.join(destRoot, '.autodev', 'session-state.json');
    if (fs.existsSync(sessionState)) { fs.rmSync(sessionState); }
  } catch { /* best effort */ }

  // 2. Provider session traces into their host stores (Strategy).
  const restoredByProvider: Record<string, number> = {};
  for (const provider of SESSION_BACKUP_PROVIDERS) {
    const n = await provider.restore(destRoot, archive);
    if (n > 0) { restoredByProvider[provider.id] = n; }
  }

  const manifest = parseManifest(archive.readText(ARCHIVE_PATHS.manifest));
  return { destRoot, workspaceFiles, restoredByProvider, manifestRestored: !!manifest };
}

/**
 * Interactive command flow: pick a backup ZIP, pick a destination folder,
 * restore, then offer to open the restored workspace.
 */
