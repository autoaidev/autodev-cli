import * as fs from 'fs';
import * as path from 'path';
import { AdmZipArchive, Archive } from './archive';
import { ARCHIVE_PATHS, IDENTITY_KEYS, ROOT_DOCS, WORKSPACE_DIRS } from './layout';
import { SESSION_BACKUP_PROVIDERS } from './sessionProviders';
import { ProviderManifestEntry, SessionManifest, readSessionState } from './manifest';

/**
 * Add the workspace `.autodev/` tree to the archive, but with `settings.json`
 * SANITIZED — the raw file holds the live WS auth token + endpoint (IDENTITY_KEYS)
 * written at connect time, and a backup ZIP is uploaded off-VM and served by the
 * download endpoint. Shipping the token would let anyone who fetches the export
 * connect AS the agent. Every other `.autodev` file is added verbatim so
 * workspace-state portability is preserved. Symlinks are skipped (walk uses
 * isFile), which also avoids following a link out of the tree.
 */
function addSanitizedAutodev(root: string, archive: Archive): void {
  const srcDir = path.join(root, '.autodev');
  if (!fs.existsSync(srcDir)) { return; }
  const archiveBase = `${ARCHIVE_PATHS.workspace}/.autodev`;
  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, rel); continue; }
      if (!e.isFile()) { continue; }
      if (rel === 'settings.json') {
        archive.addBuffer(`${archiveBase}/settings.json`, sanitizeSettings(abs));
      } else {
        archive.addFile(abs, `${archiveBase}/${rel}`);
      }
    }
  };
  walk(srcDir, '');
}

/** Read settings.json and return it with all IDENTITY_KEYS stripped. Fails
 *  closed: an unreadable/malformed file yields an empty object rather than
 *  shipping the raw (token-bearing) contents. */
function sanitizeSettings(absPath: string): Buffer {
  let obj: Record<string, unknown> = {};
  try { obj = JSON.parse(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown>; }
  catch { obj = {}; }
  for (const k of IDENTITY_KEYS) { delete obj[k]; }
  return Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

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

  // Workspace state directories (single source of truth in layout). The
  // `.autodev` tree is added via a sanitizing walk that strips the agent's WS
  // auth token from settings.json before it can leave the VM.
  for (const rel of WORKSPACE_DIRS) {
    if (rel === '.autodev') {
      addSanitizedAutodev(root, archive);
    } else {
      archive.addDir(path.join(root, rel), `${ARCHIVE_PATHS.workspace}/${rel}`);
    }
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
