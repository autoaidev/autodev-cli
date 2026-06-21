import { exec } from 'child_process';

// ---------------------------------------------------------------------------
// Copilot CLI command builder
// ---------------------------------------------------------------------------

/**
 * Build the shell command string for the copilot-cli provider.
 * Accepts a pre-combined file written by the dispatcher and passes it as a
 * single `@file` reference so copilot reads it directly.
 *
 * Resume behaviour:
 *   - sessionId provided  → --resume <id>
 *   - neither             → fresh session
 */
export function buildCopilotCliCommand(
  combinedFile: string,
  sessionId?: string,
  model?: string,
): string {
  const resumeFlag = sessionId ? ` --resume=${sessionId}` : '';
  const modelFlag  = model ? ` --model=${model}` : '';
  const flags = `--autopilot --yolo --no-ask-user --allow-all --no-auto-update --allow-all-paths --allow-all-urls --allow-all-tools --enable-all-github-mcp-tools --no-color --max-autopilot-continues 2000${resumeFlag}${modelFlag}`;
  const fileRef = JSON.stringify(`@${combinedFile}`);
  return `copilot ${flags} -p ${fileRef}`;

}

/**
 * Run a tiny probe prompt against Copilot CLI (via Node exec, not the terminal)
 * and extract the session ID from the JSON output.
 * Used to obtain a real session ID before sending the main prompt.
 */
export function probeCopilotSession(
  cwd: string,
  log: (msg: string) => void,
): Promise<string | undefined> {
  return new Promise(resolve => {
    const cmd = `copilot --yolo --allow-all --allow-all-paths --allow-all-urls --allow-all-tools --output-format json -p "session-init"`;
    log(`Copilot CLI probe: ${cmd}`);
    exec(cmd, { cwd, encoding: 'utf8', timeout: 30000 }, (_err, stdout) => {
      const match = (stdout ?? '').match(/"sessionId"\s*:\s*"([^"]+)"/);
      const id = match?.[1];
      log(`Copilot CLI probe result: ${id ?? 'no session ID found'}`);
      resolve(id);
    });
  });
}
