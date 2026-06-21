import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// OpenCode hooks manager — installs/removes an OpenCode plugin that appends
// hook events to <workspaceRoot>/.autodev/hooks-events.jsonl in the same
// format as the Claude Code hooks, so the task loop can stream them to
// Pixel Office.
//
// The plugin is placed at <workspaceRoot>/.opencode/plugins/autodev-hooks.ts
// OpenCode discovers plugins in that directory automatically.
// ---------------------------------------------------------------------------

const PLUGIN_FILENAME = 'autodev-hooks.ts';
const PLUGIN_MARKER   = '// __autodev_opencode_hooks__';

function pluginDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.opencode', 'plugins');
}

function pluginPath(workspaceRoot: string): string {
  return path.join(pluginDir(workspaceRoot), PLUGIN_FILENAME);
}

// ---------------------------------------------------------------------------
// Plugin content — TypeScript executed by OpenCode/Bun at runtime.
// The JSONL path is baked in at install time (workspace-scoped, forward
// slashes only so Bun/Windows path handling doesn't break the string).
// ---------------------------------------------------------------------------

function buildPluginContent(workspaceRoot: string): string {
  // Bake in the workspace-scoped JSONL dir with forward slashes so the
  // plugin always writes to the right place regardless of the process cwd.
  const autodevDir = JSON.stringify(
    path.join(workspaceRoot, '.autodev').replace(/\\/g, '/'),
  );
  return `${PLUGIN_MARKER}
// AutoDev hooks plugin for OpenCode — auto-generated, do not edit.
// Streams tool/session events to Pixel Office via <workspaceRoot>/.autodev/
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Dir is baked in at install time (workspace-scoped, always forward slashes)
const AUTODEV_DIR: string = ${autodevDir};
// Global file for session-ID discovery; per-session files for state tracking
const GLOBAL_JSONL = join(AUTODEV_DIR, 'hooks-events.jsonl');

function sessionJsonlPath(sessionId: string | null): string | null {
  if (!sessionId) { return null; }
  // Replace chars that are unsafe in filenames but keep the ID readable
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(AUTODEV_DIR, \`hooks-events-\${safe}.jsonl\`);
}

// High-frequency / large-payload events we intentionally skip in the generic catch-all
// (tool events have dedicated hooks; these are too noisy or already handled explicitly)
const SKIP_EVENTS = new Set([
  'message.part.delta',
  'message.part.removed',
  'message.part.updated', // replaced by session.next.text.ended (simpler, same data)
  'message.updated',      // role-tracking no longer needed
  'message.removed',
  'session.diff',
  // Explicit named hooks — don't double-log
  'tool.execute.before',
  'tool.execute.after',
  'permission.asked',
  'permission.replied',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'command.executed',
  'file.edited',
  // session.next.* lifecycle markers with no payload — skip the noisy ones
  'session.next.step.started',
  'session.next.reasoning.started',
  'session.next.text.started',
  'session.next.tool.input.started',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.success',
  // session.next.tool.failed is NOT skipped — captures error message for failed tool calls
]);

const SESSION_MAP: Record<string, string> = {
  'session.created':    'SessionStart',
  'session.idle':       'Stop',
  'session.error':      'StopFailure',
  'session.deleted':    'SessionEnd',
  'session.compacted':  'PostCompact',
  'session.updated':    'SessionStatus',
  'session.status':     'SessionStatus',
  'message.removed':    'MessageRemoved',
  'todo.updated':       'TaskCreated',
  'command.executed':   'CommandExecuted',
  'file.edited':        'FileEdited',
  'file.watcher.updated': 'FileWatcherUpdated',
  'permission.asked':   'PermissionAsked',
  'permission.replied': 'PermissionReplied',
  'server.connected':   'ServerConnected',
  'lsp.updated':        'LspUpdated',
  'installation.updated': 'InstallationUpdated',
  'tui.prompt.append':  'TuiPromptAppend',
  'tui.command.execute':'TuiCommandExecute',
  'tui.toast.show':     'TuiToastShow',
  // session.next.* meaningful events
  'session.next.prompted':       'UserMessage',
  'session.next.step.ended':     'StepEnded',
  'session.next.model.switched': 'ModelSwitched',
  'session.next.agent.switched': 'AgentSwitched',
  'session.next.reasoning.ended':'Reasoning',
};

function appendEvent(ev: Record<string, unknown>): void {
  try {
    if (!existsSync(AUTODEV_DIR)) { mkdirSync(AUTODEV_DIR, { recursive: true }); }
    ev['timestamp'] = new Date().toISOString();
    const line = JSON.stringify(ev) + '\\n';
    // Always write to global file (used for session-ID discovery)
    appendFileSync(GLOBAL_JSONL, line, 'utf8');
    // Also write to per-session file when we know the session ID
    const sid = typeof ev['session_id'] === 'string' ? ev['session_id'] as string : null;
    const perFile = sessionJsonlPath(sid);
    if (perFile) { appendFileSync(perFile, line, 'utf8'); }
  } catch { }
}

// Helper to extract session ID from various event shapes
function extractSessionId(input: any): string | null {
  return input?.sessionID ?? input?.session_id ?? input?.properties?.sessionID ?? null;
}

// Accumulated assistant text per session.
// session.next.text.ended fires once per step with the complete generated text.
// Multi-step sessions accumulate across steps and flush as AgentMessage on session.idle.
const sessionText = new Map<string, string>();

export const AutodevHooksPlugin = async () => ({
  // -------------------------------------------------------------------------
  // Tool lifecycle — explicit named hooks (these do NOT fire via generic 'event')
  // -------------------------------------------------------------------------
  'tool.execute.before': async (input: any, output?: any) => {
    appendEvent({
      hook_event_name: 'PreToolUse',
      provider:        'opencode',
      tool_name:       input?.tool ?? 'unknown',
      tool_input:      output?.args ?? input?.args ?? null,
      session_id:      extractSessionId(input),
    });
  },

  'tool.execute.after': async (input: any, output?: any) => {
    const rawOut = output?.output ?? output?.result ?? output?.text;
    const outText = typeof rawOut === 'string' ? rawOut.slice(0, 400) : null;
    appendEvent({
      hook_event_name: 'PostToolUse',
      provider:        'opencode',
      tool_name:       input?.tool ?? 'unknown',
      tool_input:      input?.args ?? null,
      tool_output:     outText != null ? { title: output?.title ?? null, text: outText } : null,
      session_id:      extractSessionId(input),
    });
  },

  // -------------------------------------------------------------------------
  // Permission hooks — explicit so we always capture even if generic 'event'
  // doesn't fire for them. Critical for detecting blocked/waiting states.
  // -------------------------------------------------------------------------
  'permission.asked': async (input: any, output?: any) => {
    appendEvent({
      hook_event_name: 'PermissionAsked',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      tool_name:       input?.tool ?? null,
      tool_input:      input?.args ?? null,
      message:         input?.message ?? input?.description ?? null,
    });
  },

  'permission.replied': async (input: any, output?: any) => {
    appendEvent({
      hook_event_name: 'PermissionReplied',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      tool_name:       input?.tool ?? null,
      granted:         input?.granted ?? output?.granted ?? null,
    });
  },

  // -------------------------------------------------------------------------
  // TUI events — explicit named hooks
  // -------------------------------------------------------------------------
  'tui.prompt.append': async (input: any) => {
    appendEvent({
      hook_event_name: 'TuiPromptAppend',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      message:         input?.text ?? null,
    });
  },

  'tui.command.execute': async (input: any) => {
    appendEvent({
      hook_event_name: 'TuiCommandExecute',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      message:         input?.command ?? input?.name ?? null,
    });
  },

  'tui.toast.show': async (input: any) => {
    appendEvent({
      hook_event_name: 'TuiToastShow',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      message:         input?.message ?? input?.text ?? null,
    });
  },

  // -------------------------------------------------------------------------
  // Command + file events — explicit named hooks
  // -------------------------------------------------------------------------
  'command.executed': async (input: any) => {
    appendEvent({
      hook_event_name: 'CommandExecuted',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      message:         input?.command ?? input?.name ?? null,
    });
  },

  'file.edited': async (input: any) => {
    appendEvent({
      hook_event_name: 'FileEdited',
      provider:        'opencode',
      session_id:      extractSessionId(input),
      message:         input?.file ?? input?.path ?? null,
    });
  },

  // -------------------------------------------------------------------------
  // Generic catch-all for remaining events (session/message/todo/lsp/server…)
  // SKIP_EVENTS excludes high-noise events and events already handled above.
  // message.part.updated (type:'text') is handled here to accumulate the AI's
  // response text; it's flushed as a single AgentMessage on session.idle.
  // -------------------------------------------------------------------------
  'event': async (ctx: any) => {
    const evt   = ctx?.event ?? ctx ?? {};
    const t: string = evt?.type ?? '';

    if (!t || SKIP_EVENTS.has(t)) { return; }

    const props     = evt?.properties ?? {};
    const sessionId = props?.sessionID ?? props?.id ?? null;
    const errMsg    = props?.error?.message ?? null;

    // --- session.next.text.ended: accumulate assistant response text per session ---
    // Fires once per step with the complete generated text. Flushed on session.idle.
    if (t === 'session.next.text.ended') {
      const text = props?.text ?? null;
      if (sessionId && typeof text === 'string' && text.trim()) {
        const prev = sessionText.get(sessionId) ?? '';
        sessionText.set(sessionId, prev ? prev + '\\n\\n' + text : text);
      }
      return; // never emit directly — flushed as AgentMessage on session.idle
    }

    // --- session.next.prompted: the user's prompt text sent to the model ---
    if (t === 'session.next.prompted') {
      const promptText = props?.prompt?.text ?? null;
      appendEvent({
        hook_event_name: 'UserMessage',
        provider:        'opencode',
        session_id:      sessionId,
        message:         typeof promptText === 'string' ? promptText.slice(0, 2000) : null,
      });
      return;
    }

    // --- session.idle: flush accumulated assistant text as AgentMessage ---
    if (t === 'session.idle' && sessionId && sessionText.has(sessionId)) {
      const text = sessionText.get(sessionId)!;
      sessionText.delete(sessionId);
      if (text.trim()) {
        appendEvent({
          hook_event_name: 'AgentMessage',
          provider:        'opencode',
          session_id:      sessionId,
          message:         text.slice(0, 3000),
        });
      }
    }

    // --- session.next.step.ended: token usage + cost ---
    if (t === 'session.next.step.ended') {
      const tokens = props?.tokens ?? null;
      const cost   = props?.cost   ?? null;
      appendEvent({
        hook_event_name: 'StepEnded',
        provider:        'opencode',
        session_id:      sessionId,
        message:         props?.finish ?? null,
        tokens:          tokens,
        cost:            cost,
      });
      return;
    }

    // Generic catch-all — extract message from known session.next.* fields
    const agentName  = props?.agent ?? null;
    const modelId    = props?.model?.id ?? props?.model?.modelID ?? null;
    const reasonText = props?.text ?? null; // session.next.reasoning.ended
    const promptText = props?.prompt?.text ?? null; // fallback
    const message    = errMsg
      ?? reasonText
      ?? promptText
      ?? (agentName && modelId ? \`\${agentName} (\${modelId})\`
         : agentName ? agentName
         : modelId  ? modelId
         : null);

    appendEvent({
      hook_event_name: SESSION_MAP[t] ?? t,
      provider:        'opencode',
      session_id:      sessionId,
      message:         message,
    });
  },
});
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isOpenCodeHooksInstalled(workspaceRoot: string): boolean {
  try {
    const content = fs.readFileSync(pluginPath(workspaceRoot), 'utf8');
    // Check both the marker AND that the dir is workspace-scoped (not a stale install).
    const expectedDir = path.join(workspaceRoot, '.autodev').replace(/\\/g, '/');
    return content.includes(PLUGIN_MARKER) && content.includes(expectedDir);
  } catch {
    return false;
  }
}

export function installOpenCodeHooks(workspaceRoot: string): void {
  const dir = pluginDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pluginPath(workspaceRoot), buildPluginContent(workspaceRoot), 'utf8');
}

/**
 * Return true if an opencode process is actively writing to the hooks JSONL.
 * Prefers the per-session file when sessionId is known; falls back to the global file.
 */
export function isOpenCodeCliActive(workspaceRoot: string, windowMs = 90_000, sessionId?: string): boolean {
  const safeId = sessionId ? sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined;
  const perFile = safeId ? path.join(workspaceRoot, '.autodev', `hooks-events-${safeId}.jsonl`) : undefined;
  const jsonlFile = (perFile && fs.existsSync(perFile))
    ? perFile
    : path.join(workspaceRoot, '.autodev', 'hooks-events.jsonl');
  try {
    const stat = fs.statSync(jsonlFile);
    if (Date.now() - stat.mtimeMs > windowMs) { return false; } // stale file
    const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.provider !== 'opencode') { continue; }
        // If reading global file, filter to the requested session
        if (!perFile && sessionId && ev.session_id && ev.session_id !== sessionId) { continue; }
        const name: string = ev.hook_event_name ?? '';
        if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd' || name === 'server.instance.disposed') { return false; }
        return true;
      } catch { continue; }
    }
    return false;
  } catch { return false; }
}

/**
 * Return true if the most recent opencode session exited cleanly (Stop event present).
 * Prefers the per-session file when sessionId is known.
 */
export function openCodeExitedCleanly(workspaceRoot: string, sessionId?: string): boolean {
  const safeId = sessionId ? sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined;
  const perFile = safeId ? path.join(workspaceRoot, '.autodev', `hooks-events-${safeId}.jsonl`) : undefined;
  const jsonlFile = (perFile && fs.existsSync(perFile))
    ? perFile
    : path.join(workspaceRoot, '.autodev', 'hooks-events.jsonl');
  try {
    const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.provider !== 'opencode') { continue; }
        if (!perFile && sessionId && ev.session_id && ev.session_id !== sessionId) { continue; }
        const name: string = ev.hook_event_name ?? '';
        if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd' || name === 'server.instance.disposed') { return true; }
        return false;
      } catch { continue; }
    }
  } catch { /* file absent */ }
  return false;
}

/**
 * Read the workspace-scoped hooks-events.jsonl and return the session ID from
 * the most recent OpenCode session event.
 * Returns undefined if the file is absent or no session event has been seen yet.
 *
 * @param notBefore  Only consider events with a timestamp >= this ISO string or
 *                   epoch-ms number.  Pass the task-start time to avoid picking
 *                   up stale/foreign sessions from before this dispatch.
 */
export function getOpenCodeSessionIdFromHooks(workspaceRoot: string, notBefore?: string | number): string | undefined {
  const jsonlFile = path.join(workspaceRoot, '.autodev', 'hooks-events.jsonl');
  const cutoff = notBefore
    ? (typeof notBefore === 'number' ? new Date(notBefore).toISOString() : notBefore)
    : undefined;
  try {
    const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n').filter(Boolean);
    // Walk backwards — most recent event first
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.provider !== 'opencode') { continue; }
        if (cutoff && ev.timestamp && ev.timestamp < cutoff) { break; } // events are chronological
        const sid: string | undefined = ev.session_id ?? undefined;
        if (sid) { return sid; }
      } catch { /* malformed line */ }
    }
  } catch { /* file absent */ }
  return undefined;
}

export function uninstallOpenCodeHooks(workspaceRoot: string): void {
  const p = pluginPath(workspaceRoot);
  if (!fs.existsSync(p)) { return; }
  try {
    const content = fs.readFileSync(p, 'utf8');
    if (content.includes(PLUGIN_MARKER)) {
      fs.unlinkSync(p);
    }
  } catch { /* ignore */ }
}
