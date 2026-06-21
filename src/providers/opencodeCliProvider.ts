import { exec, spawn } from 'child_process';

// ---------------------------------------------------------------------------
// OpenCode CLI command builder
// ---------------------------------------------------------------------------

/**
 * Build the shell command string for the opencode-cli provider.
 * Accepts a pre-combined file written by the dispatcher and passes it as a
 * single `@file` reference so opencode reads it directly.
 */
export function buildOpenCodeCliCommand(
  combinedFile: string,
  sessionId?: string,
  model?: string,
): string {
  // Resume an explicit session with `-s <id>`. On a FRESH run (no session id)
  // do NOT pass `-c`/`--continue`: opencode's "continue the last session" is
  // global, not workspace-scoped, so on the first run it attaches to a stale or
  // non-existent session and emits no output (the task never really runs). A
  // bare `opencode run` starts a new session; the dispatcher then captures its
  // id and resumes it with `-s` on subsequent iterations.
  const session = sessionId ? ` -s ${sessionId}` : '';
  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : '';
  const fileRef = JSON.stringify(`@${combinedFile}`);
  return `opencode run${session}${modelFlag} ${fileRef}`;
}

/**
 * List all OpenCode sessions for this workspace directory (newest first, capped at 20).
 * Uses `opencode session list --format json`. Returns empty array on timeout/error.
 */
export function listOpenCodeSessions(cwd: string): Promise<Array<{ id: string; mtime: number }>> {
  return new Promise(resolve => {
    let done = false;
    let stdout = '';
    const child = spawn('opencode', ['session', 'list', '-n', '20', '--format', 'json'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.unref();
    const timer = setTimeout(() => {
      if (done) { return; }
      done = true;
      try { if (child.pid !== undefined) { process.kill(-child.pid, 'SIGKILL'); } } catch { /* ignore */ }
      resolve([]);
    }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('close', () => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      try {
        const raw = JSON.parse(stdout) as Array<{ id: string; directory: string; created: number; updated: number }>;
        const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const filtered = raw
          .filter(s => s.directory.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === cwdNorm)
          .sort((a, b) => b.updated - a.updated)
          .slice(0, 20)
          .map(s => ({ id: s.id, mtime: s.updated ?? s.created ?? 0 }));
        resolve(filtered);
      } catch { resolve([]); }
    });
    child.on('error', () => { if (done) { return; } done = true; clearTimeout(timer); resolve([]); });
  });
}

/**
 * Get the latest OpenCode session ID for this workspace directory by querying
 * `opencode session list`. No tokens consumed — purely a metadata read.
 *
 * @param notBefore  Epoch-ms timestamp — ignore sessions created before this
 *                   time (used after "New Session" to skip the old session).
 */
export function getLatestOpenCodeSessionId(
  cwd: string,
  log: (msg: string) => void,
  notBefore = 0,
): Promise<string | undefined> {
  return new Promise(resolve => {
    let done = false;
    let stdout = '';

    // Use spawn with detached=true so the child gets its own process group.
    // On timeout we kill the entire group (SIGKILL) to avoid leaving the
    // opencode binary alive as a zombie when the shell wrapper exits.
    const child = spawn('opencode', ['session', 'list', '-n', '10', '--format', 'json'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.unref(); // don't prevent extension host from exiting

    const timer = setTimeout(() => {
      if (done) { return; }
      done = true;
      try {
        if (child.pid !== undefined) { process.kill(-child.pid, 'SIGKILL'); }
      } catch { /* process may have already exited */ }
      resolve(undefined);
    }, 10_000);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });

    child.on('close', () => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      try {
        const sessions = JSON.parse(stdout) as Array<{ id: string; directory: string; created: number; updated: number }>;
        const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const match = sessions
          .filter(s => s.directory.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === cwdNorm)
          .filter(s => !notBefore || (s.created ?? 0) > notBefore)
          .sort((a, b) => b.updated - a.updated)[0];
        const id = match?.id;
        log(`OpenCode session list: ${id ?? 'none found for this directory'}${notBefore ? ` (notBefore=${new Date(notBefore).toISOString()})` : ''}`);
        resolve(id);
      } catch {
        resolve(undefined);
      }
    });

    child.on('error', () => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/**
 * Run `/compact` on an existing OpenCode session to summarise conversation
 * history and free up context window space.  Returns a promise that resolves
 * when the compact command exits (success or failure — caller decides whether
 * to treat an error as fatal).
 */
export function runOpenCodeCompact(
  sessionId: string,
  cwd: string,
  log: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `opencode run -s ${sessionId} /compact`;
    log(`OpenCode compact: ${cmd}`);
    exec(cmd, { cwd, encoding: 'utf8', timeout: 120_000 }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}
