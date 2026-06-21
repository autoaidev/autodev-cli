import * as fs from 'fs';
import * as path from 'path';
import { Archive } from './archive';
import { sessionsPath, copilotSessionStateDir, normalizePath } from './layout';
import { listClaudeSessionFiles, getClaudeProjectDir } from '../providers/claudeCliProvider';
import { listOpenCodeSessions } from '../providers/opencodeCliProvider';

/**
 * How portable a provider's session traces are across a folder/machine move:
 * - `full`    — the conversation can be restored and resumed elsewhere.
 * - `partial` — some artifacts travel, but resume is best-effort/unverified.
 * - `none`    — nothing resumable on disk (in-memory only or no store).
 */
export type Portability = 'full' | 'partial' | 'none';

export interface CollectResult {
  /** Session IDs discovered for this workspace (informational). */
  discoveredIds: string[];
  /** True if real conversation traces were written into the archive. */
  tracesCaptured: boolean;
}

/**
 * Strategy for backing up and restoring one provider family's session traces.
 * Adding a provider is a new implementation — export/import never change
 * (Open/Closed). Each strategy is honest about its {@link Portability}.
 */
export interface SessionBackupProvider {
  /** Stable id — also the archive sub-folder and manifest key. */
  readonly id: string;
  /** `session-state.json` keys this strategy owns. */
  readonly sessionStateKeys: readonly string[];
  /** Portability classification (drives honest manifest + UI messaging). */
  readonly portability: Portability;
  /** Human-readable explanation of what is/isn't captured. */
  readonly note: string;
  /** Capture this provider's sessions into the archive. */
  collect(root: string, archive: Archive): Promise<CollectResult>;
  /** Restore this provider's sessions for the destination workspace. Returns files written. */
  restore(destRoot: string, archive: Archive): Promise<number>;
}

/** List the immediate child folder names under an archive directory prefix. */
function archiveChildDirs(archive: Archive, prefix: string): string[] {
  const base = prefix.replace(/\/$/, '') + '/';
  const names = new Set<string>();
  for (const entry of archive.entryPaths()) {
    if (!entry.startsWith(base)) { continue; }
    const top = entry.slice(base.length).split('/')[0];
    if (top) { names.add(top); }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Claude (covers claude-cli AND claude-tui — shared ~/.claude/projects store)
// ---------------------------------------------------------------------------

class ClaudeSessionBackup implements SessionBackupProvider {
  readonly id = 'claude';
  readonly sessionStateKeys = ['claude-cli', 'claude-tui'] as const;
  readonly portability: Portability = 'full';
  readonly note = 'JSONL traces from ~/.claude/projects re-encoded for the destination path.';

  async collect(root: string, archive: Archive): Promise<CollectResult> {
    const files = listClaudeSessionFiles(root);
    const discoveredIds: string[] = [];
    for (const f of files) {
      const sid = f.name.replace(/\.jsonl$/i, '');
      discoveredIds.push(sid);
      archive.addFile(f.full, `${sessionsPath(this.id)}/${path.basename(f.full)}`);
      // Include matching agent-* sidecar traces for this session.
      try {
        const dir = path.dirname(f.full);
        for (const child of fs.readdirSync(dir)) {
          if (child.startsWith(`agent-${sid}`) && child.endsWith('.jsonl')) {
            archive.addFile(path.join(dir, child), `${sessionsPath(this.id)}/${child}`);
          }
        }
      } catch { /* ignore */ }
    }
    return { discoveredIds, tracesCaptured: discoveredIds.length > 0 };
  }

  async restore(destRoot: string, archive: Archive): Promise<number> {
    // Claude resolves sessions by an encoding of the *destination* path, so
    // traces must land in that folder even though captured under another.
    const destDir = getClaudeProjectDir(destRoot);
    return archive.extractDir(sessionsPath(this.id), destDir);
  }
}

// ---------------------------------------------------------------------------
// Copilot CLI — ~/.copilot/session-state/<uuid>/ bound to a cwd via workspace.yaml
// ---------------------------------------------------------------------------

/** Extract the `cwd:` value from a Copilot session `workspace.yaml`. */
function readCopilotCwd(yamlPath: string): string | undefined {
  try {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const m = text.match(/^cwd:\s*(.+?)\s*$/m);
    return m?.[1];
  } catch { return undefined; }
}

/** Rewrite the `cwd:` value of a Copilot session `workspace.yaml` to `destRoot`. */
function rewriteCopilotCwd(yamlPath: string, destRoot: string): void {
  try {
    const text = fs.readFileSync(yamlPath, 'utf8');
    if (!/^cwd:\s*.+$/m.test(text)) { return; }
    const next = text.replace(/^cwd:\s*.+$/m, `cwd: ${destRoot}`);
    fs.writeFileSync(yamlPath, next, 'utf8');
  } catch { /* ignore */ }
}

class CopilotCliSessionBackup implements SessionBackupProvider {
  readonly id = 'copilot-cli';
  readonly sessionStateKeys = ['copilot-cli'] as const;
  readonly portability: Portability = 'full';
  readonly note = 'Copies ~/.copilot/session-state/<uuid>/ and rewrites workspace.yaml cwd. '
    + 'session-store.db (SQLite index) is not modified; resume by explicit --resume=<uuid>.';

  async collect(root: string, archive: Archive): Promise<CollectResult> {
    const stateDir = copilotSessionStateDir();
    const discoveredIds: string[] = [];
    let entries: string[] = [];
    try { entries = fs.readdirSync(stateDir); } catch { return { discoveredIds, tracesCaptured: false }; }
    const target = normalizePath(root);
    for (const uuid of entries) {
      const dir = path.join(stateDir, uuid);
      try { if (!fs.statSync(dir).isDirectory()) { continue; } } catch { continue; }
      const cwd = readCopilotCwd(path.join(dir, 'workspace.yaml'));
      if (!cwd || normalizePath(cwd) !== target) { continue; }
      archive.addDir(dir, `${sessionsPath(this.id)}/${uuid}`);
      discoveredIds.push(uuid);
    }
    return { discoveredIds, tracesCaptured: discoveredIds.length > 0 };
  }

  async restore(destRoot: string, archive: Archive): Promise<number> {
    const stateDir = copilotSessionStateDir();
    let written = 0;
    for (const uuid of archiveChildDirs(archive, sessionsPath(this.id))) {
      const target = path.join(stateDir, uuid);
      written += archive.extractDir(`${sessionsPath(this.id)}/${uuid}`, target);
      rewriteCopilotCwd(path.join(target, 'workspace.yaml'), destRoot);
    }
    return written;
  }
}

// ---------------------------------------------------------------------------
// Non-portable providers — recorded honestly, no trace capture/restore.
// ---------------------------------------------------------------------------

/** OpenCode (cli + sdk): sessions live in SQLite opencode.db — not portable per-session. */
class OpenCodeSessionBackup implements SessionBackupProvider {
  readonly id = 'opencode';
  readonly sessionStateKeys = ['opencode-cli', 'opencode-sdk'] as const;
  readonly portability: Portability = 'none';
  readonly note = 'OpenCode stores sessions in a shared SQLite opencode.db; per-session '
    + 'export is not supported. Session IDs are recorded for reference only.';

  async collect(root: string): Promise<CollectResult> {
    let discoveredIds: string[] = [];
    try { discoveredIds = (await listOpenCodeSessions(root)).map(s => s.id); } catch { /* ignore */ }
    return { discoveredIds, tracesCaptured: false };
  }

  async restore(): Promise<number> { return 0; }
}

/** Copilot SDK: in-process LocalSession with a synthetic id — nothing on disk. */
class CopilotSdkSessionBackup implements SessionBackupProvider {
  readonly id = 'copilot-sdk';
  readonly sessionStateKeys = ['copilot-sdk'] as const;
  readonly portability: Portability = 'none';
  readonly note = 'Copilot SDK sessions are in-memory only; no resumable trace exists on disk.';

  async collect(): Promise<CollectResult> { return { discoveredIds: [], tracesCaptured: false }; }
  async restore(): Promise<number> { return 0; }
}

/** Grok TUI: fresh process per task, no session store at all. */
class GrokSessionBackup implements SessionBackupProvider {
  readonly id = 'grok-tui';
  readonly sessionStateKeys = ['grok-tui'] as const;
  readonly portability: Portability = 'none';
  readonly note = 'Grok TUI keeps no session state; each task is an independent process.';

  async collect(): Promise<CollectResult> { return { discoveredIds: [], tracesCaptured: false }; }
  async restore(): Promise<number> { return 0; }
}

/** All registered session-backup strategies (covers every ProviderId). */
export const SESSION_BACKUP_PROVIDERS: readonly SessionBackupProvider[] = [
  new ClaudeSessionBackup(),
  new CopilotCliSessionBackup(),
  new OpenCodeSessionBackup(),
  new CopilotSdkSessionBackup(),
  new GrokSessionBackup(),
];
