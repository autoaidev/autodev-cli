// ---------------------------------------------------------------------------
// Shared shell-command builders used by every CLI provider strategy AND the
// dispatcher. Extracted from dispatcher.ts so the provider classes can reuse
// them without a circular import (DRY — one definition of how we tee output,
// capture exit codes, and bracket a run with synthetic hook events).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getManualHookCmd } from '../hooksManager';

/** Tee a command's combined stdout/stderr to `outFile` (UTF-8, BOM-aware). */
export function teeCommand(cmd: string, outFile: string): string {
  if (os.platform() === 'win32') {
    const utf8NoBom = 'New-Object System.Text.UTF8Encoding($false)';
    return `$OutputEncoding=${utf8NoBom}; [Console]::OutputEncoding=${utf8NoBom}; ${cmd} 2>&1 | Tee-Object -FilePath ${JSON.stringify(outFile)}`;
  }
  return `{ LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ${cmd}; } 2>&1 | tee ${JSON.stringify(outFile)}`;
}

/** Append a step that writes the command's exit code to `exitFile`. */
export function withExitFile(cmd: string, exitFile: string): string {
  const q = JSON.stringify(exitFile);
  if (os.platform() === 'win32') {
    return `${cmd}; [System.IO.File]::WriteAllText(${q}, $LASTEXITCODE.ToString())`;
  }
  return `{ ${cmd}; echo $? > ${q}; }`;
}

/**
 * Bracket a command with synthetic SessionStart / SessionEnd hook events
 * (`.autodev/hooks-events.jsonl`) for providers without native hooks
 * (copilot-cli, opencode-cli). The post hook always runs even on failure.
 */
export function wrapWithSyntheticHooks(cmd: string, provider: string, workspaceRoot: string, sessionName: string): string {
  const pre  = getManualHookCmd(provider, 'SessionStart', workspaceRoot, sessionName);
  const post = getManualHookCmd(provider, 'SessionEnd',   workspaceRoot, sessionName);
  if (os.platform() === 'win32') {
    return `${pre}; ${cmd}; ${post}`;
  }
  return `${pre}; { ${cmd}; }; ${post}`;
}

/** Combine profile + message into a temp file under `.autodev/messages/` and return its path. */
export function writeCombinedFile(root: string, agentProfileFile: string, messageFile: string, includeProfile: boolean): string {
  const msgsDir = path.join(root, '.autodev', 'messages');
  if (!fs.existsSync(msgsDir)) { fs.mkdirSync(msgsDir, { recursive: true }); }
  const msgContent = fs.readFileSync(messageFile, 'utf8');
  let combined = msgContent;
  if (includeProfile) {
    const profileContent = fs.readFileSync(agentProfileFile, 'utf8');
    // Task message FIRST so the agent sees the current task immediately.
    combined = `${msgContent}\n\n---\n\n${profileContent}`;
  }
  const combinedFile = path.join(msgsDir, `temp_${Date.now()}.md`);
  fs.writeFileSync(combinedFile, combined, 'utf8');
  return combinedFile;
}
