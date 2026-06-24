import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// ---------------------------------------------------------------------------
// Claude project-folder / JSONL session helpers
// ---------------------------------------------------------------------------

/**
 * Encode a workspace path the way Claude Code names its `~/.claude/projects/`
 * folders: every `:`, `\`, `/` becomes `-`, and runs of dashes are collapsed.
 * Note: Claude **keeps the leading dash** that comes from a leading slash on
 * POSIX paths (e.g. `/home/x/foo` → `-home-x-foo`), so we don't strip `^-`.
 * Trailing dashes are dropped.
 */
export function claudeProjectFolder(workspacePath: string): string {
  return workspacePath.replace(/[:\\/]/g, '-').replace(/-+/g, '-').replace(/-$/g, '');
}

/**
 * Compute the `~/.claude/projects/<encoded>` directory for a workspace,
 * regardless of whether it already exists. Used when restoring an agent
 * backup into a new folder: the destination's session traces must land in
 * the project dir that Claude will look up for that folder.
 */
export function getClaudeProjectDir(workspacePath: string): string {
  const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'projects', claudeProjectFolder(workspacePath));
}

/**
 * Resolve the Claude `~/.claude/projects/<encoded>` folder for this workspace.
 * Match is **exact** (case-insensitive only on Windows). We try the primary
 * encoding and a no-leading-dash fallback so historical folders created by
 * older Claude versions still resolve. Prefix matching is intentionally NOT
 * used — the previous fuzzy match (`startsWith(encoded.slice(0,8))`) caused
 * two VS Code instances opened in sibling directories like
 * `-home-code-foo` and `-home-code1-bar` (sharing prefix `-home-cod`) to
 * pick up each other's session JSONLs and end up resuming the same Claude
 * session.
 */
function findClaudeProjectDir(workspacePath: string): string | undefined {
  try {
    const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const projectsDir = path.join(claudeDir, 'projects');
    const encoded = claudeProjectFolder(workspacePath);
    const candidates = [encoded, encoded.replace(/^-+/, '')];
    const folders = fs.readdirSync(projectsDir);
    const isWindows = process.platform === 'win32';
    const norm = (s: string) => (isWindows ? s.toLowerCase() : s);
    const targets = new Set(candidates.map(norm));
    const match = folders.find(f => targets.has(norm(f)));
    return match ? path.join(projectsDir, match) : undefined;
  } catch { return undefined; }
}

export function listClaudeSessionFiles(workspacePath: string): Array<{ name: string; mtime: number; full: string }> {
  const sessionsDir = findClaudeProjectDir(workspacePath);
  if (!sessionsDir) { return []; }
  try {
    return fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs, full: path.join(sessionsDir, f) }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

export function listClaudeSessions(workspacePath: string): Array<{ id: string; mtime: number }> {
  return listClaudeSessionFiles(workspacePath).map(f => ({
    id: f.name.replace('.jsonl', ''),
    mtime: f.mtime,
  }));
}

export function findLatestClaudeSession(workspacePath: string): string | undefined {
  return listClaudeSessionFiles(workspacePath)[0]?.name.replace('.jsonl', '');
}

/**
 * Set the display NAME shown for a Claude session in the `claude --resume`
 * picker. This Claude version has no dedicated title field — the picker label is
 * the `display` value in ~/.claude/history.jsonl keyed by sessionId. We APPEND a
 * fresh entry (never rewrite existing lines, so history can't be corrupted); the
 * picker surfaces the latest display for the session.
 */
/** Read the display NAME shown for a claude session in the --resume picker
 *  (latest `display` for this sessionId in ~/.claude/history.jsonl). */
export function getClaudeSessionDisplay(sessionId: string): string | undefined {
  try {
    const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const histFile = path.join(claudeDir, 'history.jsonl');
    if (!fs.existsSync(histFile)) { return undefined; }
    let display: string | undefined;
    for (const line of fs.readFileSync(histFile, 'utf8').split('\n')) {
      if (!line.trim()) { continue; }
      try { const e = JSON.parse(line); if (e.sessionId === sessionId && e.display) { display = e.display; } } catch { /* skip */ }
    }
    return display;
  } catch { return undefined; }
}

export function setClaudeSessionName(sessionId: string, name: string, cwd: string): void {
  if (!sessionId || !name) { return; }
  try {
    const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const histFile = path.join(claudeDir, 'history.jsonl');
    const entry = { display: name, pastedContents: {}, timestamp: Date.now(), project: cwd, sessionId };
    fs.appendFileSync(histFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-critical */ }
}


function resolveClaudeJsonl(workspacePath: string): string | undefined {
  return listClaudeSessionFiles(workspacePath)[0]?.full;
}

export function getClaudeSessionCursor(workspacePath: string): number {
  const p = resolveClaudeJsonl(workspacePath);
  if (!p) { return 0; }
  try { return fs.statSync(p).size; } catch { return 0; }
}

export interface ClaudeSessionState {
  /** True if a definitive turn-end was detected. */
  hasEndTurn: boolean;
  /** Human-readable label for the tool currently running, if any. */
  activeToolStatus?: string;
  /** True if a bash_progress or mcp_progress record was seen. */
  hasProgress: boolean;
  /** Set when a rate_limit error is found — contains the raw message text. */
  rateLimitMessage?: string;
}

function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':    return `Reading ${base(input['file_path'])}`;
    case 'Edit':    return `Editing ${base(input['file_path'])}`;
    case 'Write':   return `Writing ${base(input['file_path'])}`;
    case 'Bash': {
      const cmd = String(input['command'] ?? '');
      return `Running: ${cmd.length > 60 ? cmd.slice(0, 60) + '\u2026' : cmd}`;
    }
    case 'Glob':      return 'Searching files';
    case 'Grep':      return 'Searching code';
    case 'WebFetch':  return 'Fetching web content';
    case 'WebSearch': return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input['description'] === 'string' ? input['description'] as string : '';
      return desc ? `Subtask: ${desc.length > 50 ? desc.slice(0, 50) + '\u2026' : desc}` : 'Running subtask';
    }
    case 'AskUserQuestion': return 'Waiting for answer';
    case 'EnterPlanMode':   return 'Planning';
    default: return `Using ${toolName}`;
  }
}

export function parseClaudeStateSince(workspacePath: string, fromByte: number): ClaudeSessionState {
  const result: ClaudeSessionState = { hasEndTurn: false, hasProgress: false };
  const p = resolveClaudeJsonl(workspacePath);
  if (!p) { return result; }
  try {
    const size = fs.statSync(p).size;
    if (size <= fromByte) { return result; }
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buf, 0, buf.length, fromByte);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) { continue; }
      try {
        const record = JSON.parse(t) as Record<string, unknown>;
        const rtype = record['type'] as string | undefined;

        if (rtype === 'assistant') {
          const msgContent = (record['message'] as Record<string, unknown> | undefined)?.['content']
            ?? record['content'];
          if (Array.isArray(msgContent)) {
            for (const block of msgContent as Array<Record<string, unknown>>) {
              if (block['type'] === 'tool_use') {
                const name = String(block['name'] ?? '');
                const input = (block['input'] ?? {}) as Record<string, unknown>;
                result.activeToolStatus = formatToolStatus(name, input);
                result.hasEndTurn = false;
              }
            }
          }
        } else if (rtype === 'user') {
          const msgContent = (record['message'] as Record<string, unknown> | undefined)?.['content']
            ?? record['content'];
          if (Array.isArray(msgContent)) {
            const hasToolResult = (msgContent as Array<Record<string, unknown>>)
              .some(b => b['type'] === 'tool_result');
            if (!hasToolResult) {
              result.activeToolStatus = undefined;
              result.hasEndTurn = false;
            }
          }
        } else if (rtype === 'system') {
          if ((record['subtype'] as string | undefined) === 'turn_duration') {
            result.hasEndTurn = true;
            result.activeToolStatus = undefined;
          }
        } else if (rtype === 'progress') {
          const data = record['data'] as Record<string, unknown> | undefined;
          const dataType = data?.['type'] as string | undefined;
          if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
            result.hasProgress = true;
          }
        }

        if ((record['stop_reason'] as string | undefined) === 'end_turn') {
          result.hasEndTurn = true;
        }

        // Rate limit detection — error:"rate_limit" on assistant records
        if (record['error'] === 'rate_limit') {
          const msgContent = (record['message'] as Record<string, unknown> | undefined)?.['content'];
          const text = Array.isArray(msgContent)
            ? (msgContent as Array<Record<string, unknown>>)
                .filter(b => b['type'] === 'text')
                .map(b => String(b['text'] ?? '')).join(' ')
            : '';
          if (text) { result.rateLimitMessage = text; }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file unreadable */ }
  return result;
}

/** @deprecated Use parseClaudeStateSince instead. */
export function hasClaudeEndTurnSince(workspacePath: string, fromByte: number): boolean {
  return parseClaudeStateSince(workspacePath, fromByte).hasEndTurn;
}

export function readClaudeOutputSince(workspacePath: string, fromByte: number): string {
  const p = resolveClaudeJsonl(workspacePath);
  if (!p) { return ''; }
  try {
    const size = fs.statSync(p).size;
    if (size <= fromByte) { return ''; }
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buf, 0, buf.length, fromByte);
    fs.closeSync(fd);
    const parts: string[] = [];
    for (const line of buf.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        const entryMsg = entry['message'] as { role?: string; content?: Array<{ type?: string; text?: string }> | string } | undefined;
        if (entry['type'] === 'assistant' || entryMsg?.role === 'assistant') {
          const content = entryMsg?.content;
          if (typeof content === 'string') {
            parts.push(content);
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) { parts.push(part.text); }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }
    return parts.join('\n\n');
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Claude CLI command builder
// ---------------------------------------------------------------------------

/** Build the shell command string for the claude-cli provider. */
export function buildClaudeCliCommand(
  agentProfileFile: string,
  messageFile: string,
  sessionId?: string,
  includeProfile = true,
  model?: string,
): string {
  const resume = sessionId ? ` --resume ${sessionId}` : '';
  const resolvedModel = model?.replace(/-1m$/i, '');
  const modelFlag = resolvedModel ? ` --model ${resolvedModel}` : '';
  // -p takes ONE prompt argument. Concatenate both @file refs into a single
  // quoted string so Claude sees both — passing them as two args drops the
  // second one silently (claude consumes the first as the prompt).
  const promptArg = includeProfile
    ? JSON.stringify(`@${agentProfileFile} @${messageFile}`)
    : JSON.stringify(`@${messageFile}`);
  return `claude --allow-dangerously-skip-permissions --dangerously-skip-permissions${resume}${modelFlag} -p ${promptArg}`;
}

/**
 * Run a tiny probe prompt via Node exec to obtain a claude-cli session ID
 * before the main prompt runs. Extracts "session_id" from --output-format json output.
 */
export function probeClaudeSession(
  cwd: string,
  log: (msg: string) => void,
): Promise<string | undefined> {
  return new Promise(resolve => {
    const cmd = `claude --dangerously-skip-permissions --output-format json -p "."` ;
    log(`Claude CLI probe: ${cmd}`);
    exec(cmd, { cwd, encoding: 'utf8', timeout: 30000 }, (_err, stdout) => {
      const id = (stdout ?? '').match(/"session_id"\s*:\s*"([^"]+)"/)?.[1];
      log(`Claude CLI probe result: ${id ?? 'no session ID found'}`);
      resolve(id);
    });
  });
}

/**
 * Run `/compact` on an existing Claude session to summarise conversation
 * history and free up context window space. Used after Claude returns
 * `prompt is too long: N tokens > MAX maximum` (HTTP 400). Resolves on exit
 * (success or failure — caller decides what to do).
 */
export function runClaudeCompact(
  sessionId: string,
  cwd: string,
  log: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // /compact is a slash-command Claude understands in non-interactive mode.
    // --resume re-attaches to the same session before running it.
    const cmd = `claude --dangerously-skip-permissions --resume ${sessionId} -p "/compact"`;
    log(`Claude compact: ${cmd}`);
    exec(cmd, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log(`Claude compact stderr: ${(err.message ?? '').slice(0, 300)}`);
        reject(err);
      } else {
        log(`Claude compact done (${stdout.length} bytes of output)`);
        resolve();
      }
    });
  });
}

/**
 * Run `/clear` on an existing Claude session to wipe the conversation history
 * and start fresh. Used when autocompact is thrashing (context refills to
 * limit immediately after compact). Resolves on exit.
 */
export function runClaudeClear(
  sessionId: string,
  cwd: string,
  log: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `claude --dangerously-skip-permissions --resume ${sessionId} -p "/clear"`;
    log(`Claude clear: ${cmd}`);
    exec(cmd, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log(`Claude clear stderr: ${(err.message ?? '').slice(0, 300)}`);
        reject(err);
      } else {
        log(`Claude clear done (${stdout.length} bytes of output)`);
        resolve();
      }
    });
  });
}
