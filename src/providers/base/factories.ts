// ---------------------------------------------------------------------------
// Factory generation for provider tests. Shapes mirror pixel-office
// HookPayloadFactory + the real fixtures under
// external/pixel-office/tests/Fixtures/traces so unit tests never invent
// a one-off event schema.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { SETTINGS_DEFAULTS, AutodevSettings } from '../../core/settingsLoader';
import { DispatchRequest, DispatchContext } from './contract';
import { eventTypeFor } from './ProviderNormalizer';
import type { HookEvent, ModelInfo, SessionRecord, TranscriptMsg, UsagePayload } from './types';

export interface HookFactoryOpts {
  cwd?: string;
  sessionId?: string;
  provider?: string;
  timestamp?: string;
}

/** Build realistic hook events the way pixel-office's HookPayloadFactory does. */
export class HookEventFactory {
  cwd: string;
  sessionId: string;
  provider: string;
  timestamp: string;

  constructor(opts: HookFactoryOpts = {}) {
    this.cwd = opts.cwd ?? '/workspace/todo-app';
    this.sessionId = opts.sessionId ?? randomUUID();
    this.provider = opts.provider ?? 'claude-cli';
    this.timestamp = opts.timestamp ?? new Date().toISOString();
  }

  static make(opts?: HookFactoryOpts): HookEventFactory {
    return new HookEventFactory(opts);
  }

  with(over: Partial<HookFactoryOpts>): HookEventFactory {
    return new HookEventFactory({
      cwd: over.cwd ?? this.cwd,
      sessionId: over.sessionId ?? this.sessionId,
      provider: over.provider ?? this.provider,
      timestamp: over.timestamp ?? this.timestamp,
    });
  }

  private claudeLike(name: string, extra: Record<string, unknown> = {}): HookEvent {
    return {
      hook_event_name: name,
      event_type: eventTypeFor(name),
      provider: this.provider,
      cwd: this.cwd,
      timestamp: this.timestamp,
      session_id: this.sessionId,
      ...extra,
    };
  }

  sessionStart(source = 'startup'): HookEvent {
    return this.claudeLike('SessionStart', { source });
  }

  sessionEnd(reason = 'completed'): HookEvent {
    return this.claudeLike('SessionEnd', { reason });
  }

  userPromptSubmit(prompt = 'Build a todo app'): HookEvent {
    return this.claudeLike('UserPromptSubmit', { message: prompt });
  }

  notification(message: string): HookEvent {
    return this.claudeLike('Notification', {
      message,
      title: this.provider,
      tool_name: this.provider,
    });
  }

  toolStart(toolName: string, input: Record<string, unknown> = {}, toolUseId?: string): HookEvent {
    const id = toolUseId ?? `call-${randomUUID()}`;
    return this.claudeLike('PreToolUse', {
      tool_name: toolName,
      tool_input: Object.keys(input).length ? input : defaultToolInput(toolName, this.cwd),
      tool_use_id: id,
      session_id: this.sessionId,
    });
  }

  toolEnd(
    toolName: string,
    inputOrOutput: Record<string, unknown> = {},
    toolUseId?: string,
    failure = false,
  ): HookEvent {
    const id = toolUseId ?? `call-${randomUUID()}`;
    const outputText = String(inputOrOutput['output'] ?? inputOrOutput['text'] ?? `✓ ${toolName} ok`);
    const input = { ...inputOrOutput };
    delete input['output'];
    delete input['text'];
    return this.claudeLike(failure ? 'PostToolUseFailure' : 'PostToolUse', {
      tool_name: toolName,
      tool_input: Object.keys(input).length ? input : defaultToolInput(toolName, this.cwd),
      tool_output: { text: outputText },
      tool_use_id: id,
      success: !failure,
    });
  }

  agentMessage(message: string): HookEvent {
    return this.claudeLike('AgentMessage', { message });
  }

  stop(reason?: string): HookEvent {
    return this.claudeLike('Stop', reason ? { reason } : {});
  }

  stopFailure(reason = 'watchdog_timeout'): HookEvent {
    return this.claudeLike('StopFailure', { reason });
  }

  permissionRequest(tool = 'Bash', command = 'rm -rf /'): HookEvent {
    return this.claudeLike('PermissionRequest', {
      tool_name: tool,
      tool_input: { command },
      message: `Allow ${tool}?`,
    });
  }

  todoUpdated(todos?: Array<{ id?: string; content?: string; status?: string }>): HookEvent {
    const list = todos ?? [
      { id: '1', content: 'Scaffold index.html', status: 'completed' },
      { id: '2', content: 'Implement add/toggle/delete in app.js', status: 'in_progress' },
      { id: '3', content: 'Style with CSS', status: 'pending' },
    ];
    return this.claudeLike('TaskCreated', {
      task_id: `todo-${randomUUID().slice(0, 8)}`,
      task_subject: list[1]?.content ?? 'Todo update',
      task_description: JSON.stringify(list),
    });
  }

  /**
   * Full todo-app lifecycle matching pixel-office HookPayloadFactory::todoAppLifecycle.
   * Used by the dummy agent and by factory-driven tests.
   */
  todoAppLifecycle(): HookEvent[] {
    const writeId = `call-${randomUUID()}`;
    const readId = `call-${randomUUID()}`;
    const writeTool = writeToolFor(this.provider);
    return [
      this.sessionStart(),
      this.userPromptSubmit('Build a sample todo app with add/complete/delete'),
      this.notification('Starting work on the sample todo app…'),
      this.toolStart('list_dir', { target_directory: this.cwd }),
      this.toolEnd('list_dir', { target_directory: this.cwd, output: `- ${this.cwd}/\n  - README.md\n` }),
      this.toolStart('read_file', { target_file: `${this.cwd}/README.md` }, readId),
      this.toolEnd('read_file', { target_file: `${this.cwd}/README.md`, output: '# Todo App workspace' }, readId),
      this.toolStart(writeTool, {
        file_path: `${this.cwd}/index.html`,
        content: '<!doctype html><title>Todos</title><div id="app"></div><script src="app.js"></script>',
      }, writeId),
      this.toolEnd(writeTool, { file_path: `${this.cwd}/index.html`, output: 'Wrote index.html' }, writeId),
      this.todoUpdated(),
      this.notification('Todo scaffold written. Handing styles to teammate.'),
      this.sessionEnd(),
    ];
  }
}

function writeToolFor(provider: string): string {
  if (provider.startsWith('grok')) return 'search_replace';
  if (provider.startsWith('copilot')) return 'create_file';
  if (provider.startsWith('opencode')) return 'write';
  if (provider.startsWith('dummy')) return 'Write';
  return 'Write';
}

function defaultToolInput(toolName: string, cwd: string): Record<string, unknown> {
  switch (toolName) {
    case 'read_file': case 'Read': case 'view':
      return { target_file: `${cwd}/README.md` };
    case 'list_dir': case 'LS': case 'list_bash':
      return { target_directory: cwd };
    case 'run_terminal_command': case 'Bash': case 'shell':
      return { command: 'ls -la' };
    case 'search_replace': case 'Edit': case 'Write': case 'write': case 'create_file':
      return { file_path: `${cwd}/app.js`, content: '// todo app' };
    default:
      return { input: toolName };
  }
}

/** Factory for DispatchRequest DTOs used by manager.dispatch tests. */
export class DispatchRequestFactory {
  static make(over: Partial<DispatchRequest> & { root: string }): DispatchRequest {
    return {
      root: over.root,
      agentProfileFile: over.agentProfileFile ?? `${over.root}/.autodev/AGENT_PROFILE.md`,
      messageFile: over.messageFile ?? `${over.root}/.autodev/MESSAGE.md`,
      combinedFile: over.combinedFile ?? `${over.root}/.autodev/messages/temp_1.md`,
      resolvedSessionId: over.resolvedSessionId,
      includeProfile: over.includeProfile ?? true,
      settings: (over.settings ?? { ...SETTINGS_DEFAULTS, hooksEnabled: false }) as AutodevSettings,
      stdoutFile: over.stdoutFile ?? `${over.root}/out.log`,
      exitFile: over.exitFile ?? `${over.root}/exit.code`,
    };
  }

  static context(over: Partial<DispatchContext> = {}): DispatchContext {
    return {
      log: over.log ?? (() => {}),
      launcher: over.launcher ?? { launch() { /* no-op */ } },
      showOutput: over.showOutput ?? (() => {}),
    };
  }
}

/** Factory for session records / transcripts. */
export class SessionFactory {
  static record(over: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: over.id ?? randomUUID(),
      name: over.name ?? '(untitled)',
      cwd: over.cwd ?? '/workspace/todo-app',
      updated: over.updated ?? Date.now(),
      file: over.file,
      msgs: over.msgs ?? 3,
    };
  }

  static transcript(over: { user?: string; assistant?: string } = {}): TranscriptMsg[] {
    return [
      { role: 'user', text: over.user ?? 'Build a todo app', ts: Date.now() - 2000 },
      { role: 'assistant', text: over.assistant ?? 'I will scaffold index.html and app.js.', ts: Date.now() - 1000 },
      { role: 'tool', text: '🔧 Write({"file_path":"index.html"})', ts: Date.now() },
    ];
  }
}

/** Factory for usage snapshots. */
export class UsageFactory {
  static make(over: Partial<UsagePayload> = {}): UsagePayload {
    const input = over.inputTokens ?? 5000;
    const output = over.outputTokens ?? 1200;
    const context = over.contextTokens ?? 40_000;
    const limit = 200_000;
    return {
      tokens: over.tokens ?? input + output,
      inputTokens: input,
      outputTokens: output,
      contextTokens: context,
      contextPct: over.contextPct ?? Math.round((context / limit) * 1000) / 10,
    };
  }

  static claudeBlock(over: Record<string, number> = {}): Record<string, number> {
    return {
      input_tokens: over['input_tokens'] ?? 5000,
      output_tokens: over['output_tokens'] ?? 1200,
      cache_read_input_tokens: over['cache_read_input_tokens'] ?? 30_000,
      cache_creation_input_tokens: over['cache_creation_input_tokens'] ?? 5000,
    };
  }

  static copilotBlock(over: Record<string, number> = {}): Record<string, number> {
    return {
      inputTokens: over['inputTokens'] ?? 4200,
      outputTokens: over['outputTokens'] ?? 800,
      contextTokens: over['contextTokens'] ?? 24_000,
    };
  }
}

/** Factory for model catalog entries. */
export class ModelFactory {
  static make(over: Partial<ModelInfo> = {}): ModelInfo {
    return {
      id: over.id ?? 'dummy-fast',
      label: over.label ?? 'Dummy Fast',
      contextLimit: over.contextLimit ?? 128_000,
    };
  }
}
