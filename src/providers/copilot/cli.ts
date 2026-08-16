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
  sessionName?: string,
  mcpConfigFile?: string,
): string {
  const resumeFlag = sessionId ? ` --resume=${sessionId}` : '';
  const modelFlag  = model ? ` --model=${model}` : '';
  // `--name` only applies to a NEW session (resume keeps the prior name).
  const nameFlag   = (!sessionId && sessionName) ? ` --name ${JSON.stringify(sessionName)}` : '';
  // Per-workspace MCP config. Copilot's own config file is GLOBAL, so on a box
  // running several agents each sync clobbered the last and every copilot agent
  // wound up driving whichever workspace synced most recently — i.e. operating
  // the WRONG office character, since the pixel-office entry carries that agent's
  // bearer token. `--additional-mcp-config @<file>` is per session, so pointing it
  // at a file inside the workspace keeps agents from fighting over one config.
  // (See copilotMcpConfigPath(); the `@` prefix means "read this path".)
  const mcpFlag = mcpConfigFile ? ` --additional-mcp-config ${JSON.stringify(`@${mcpConfigFile}`)}` : '';
  const flags = `--autopilot --yolo --no-ask-user --allow-all --no-auto-update --allow-all-paths --allow-all-urls --allow-all-tools --enable-all-github-mcp-tools --no-color --max-autopilot-continues 2000${resumeFlag}${modelFlag}${nameFlag}${mcpFlag}`;
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
