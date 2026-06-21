import * as path from 'path';
import { AdmZipArchive } from './archive';
import { ARCHIVE_PATHS, ROOT_DOCS, WORKSPACE_DIRS } from './layout';
import { SESSION_BACKUP_PROVIDERS } from './sessionProviders';
import { ProviderManifestEntry, SessionManifest, readSessionState } from './manifest';

export interface ExportResult {
  destPath: string;
  /** Provider ids for which real traces were captured. */
  capturedProviders: string[];
  /** Per-provider manifest entries (portability, discovered IDs, etc.). */
  providers: Record<string, ProviderManifestEntry>;
}

/**
 * Pure (vscode-free) core: build and write the agent backup ZIP.
 * Called both by the VS Code command (with a dialog-chosen path) and directly
 * from the CLI (with a CLI-supplied path).
 */
export async function createAgentBackup(root: string, destPath: string): Promise<ExportResult> {
  const archive = AdmZipArchive.create();

  // Workspace state directories (single source of truth in layout).
  for (const rel of WORKSPACE_DIRS) {
    archive.addDir(path.join(root, rel), `${ARCHIVE_PATHS.workspace}/${rel}`);
  }

  // Root-level agent docs.
  for (const f of ROOT_DOCS) {
    archive.addFile(path.join(root, f), `${ARCHIVE_PATHS.workspace}/${f}`);
  }

  // Provider session traces (Strategy — one entry per provider family).
  const sessionState = readSessionState(root);
  const providers: Record<string, ProviderManifestEntry> = {};
  const capturedProviders: string[] = [];
  for (const provider of SESSION_BACKUP_PROVIDERS) {
    const result = await provider.collect(root, archive);
    const connected: Record<string, string | null> = {};
    for (const key of provider.sessionStateKeys) {
      connected[key] = sessionState[key] ?? null;
    }
    providers[provider.id] = {
      portability: provider.portability,
      note: provider.note,
      discoveredSessionIds: result.discoveredIds,
      connectedSessionIds: connected,
      tracesCaptured: result.tracesCaptured,
    };
    if (result.tracesCaptured) { capturedProviders.push(provider.id); }
  }

  // Session-ID manifest (per-provider, honest portability tags).
  const manifest: SessionManifest = {
    exportedAt: new Date().toISOString(),
    workspaceRoot: root,
    providers,
  };
  archive.addBuffer(ARCHIVE_PATHS.manifest, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  archive.write(destPath);

  return { destPath, capturedProviders, providers };
}

/**
 * VS Code command handler: show a save dialog then call {@link createAgentBackup}.
 * Imports `vscode` lazily so this module stays loadable outside the extension host.
 */
