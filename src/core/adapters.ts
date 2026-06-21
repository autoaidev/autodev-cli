import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Shared abstractions — injected into TaskLoopRunner and sendPromptToAi so that
// the core loop logic works both inside VS Code and as a standalone Node.js SDK.
// ---------------------------------------------------------------------------

export interface IDisposable {
  dispose(): void;
}

/**
 * Watches a file path for change/create events.
 * VS Code implementation uses `vscode.workspace.createFileSystemWatcher`.
 * Node.js implementation uses `fs.watch` on the parent directory.
 */
export interface IFileWatcher {
  watch(filePath: string, onChange: () => void): IDisposable;
}

/**
 * Launches a shell command in a named context.
 * VS Code implementation creates an integrated terminal.
 * Node.js implementation uses `child_process.spawn`.
 */
export interface IProcessLauncher {
  launch(cmd: string, name: string, cwd: string): void;
}

// ---------------------------------------------------------------------------
// Node.js implementations
// ---------------------------------------------------------------------------

/**
 * Watches the parent directory of `filePath` and fires `onChange` whenever
 * the target file changes or is created.  Handles non-existent directories
 * gracefully (watcher is a no-op until the directory appears).
 */
export class NodeFileWatcher implements IFileWatcher {
  watch(filePath: string, onChange: () => void): IDisposable {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    let watcher: fs.FSWatcher | undefined;
    try {
      if (fs.existsSync(dir)) {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (filename === base) { onChange(); }
        });
      }
    } catch { /* directory may not exist yet — no-op watcher */ }
    return { dispose: () => { try { watcher?.close(); } catch { /* ignore */ } } };
  }
}

/**
 * Spawns a shell process (stdout/stderr inherited to the parent process).
 * On Windows uses `powershell -Command`; on Unix uses `/bin/sh -c`.
 */
export class NodeProcessLauncher implements IProcessLauncher {
  launch(cmd: string, name: string, cwd: string): void {
    const [shell, flag] = process.platform === 'win32'
      ? ['powershell', '-Command']
      : ['/bin/sh', '-c'];
    const proc = spawn(shell, [flag, cmd], { cwd, stdio: 'inherit', detached: false });
    proc.on('error', (err) => console.error(`[${name}] spawn error:`, err.message));
  }
}
