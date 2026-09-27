// ---------------------------------------------------------------------------
// GrokAcpSession — a PERSISTENT `grok agent stdio` process, one per workspace
// root, that stays alive across MANY turns in a SINGLE process.
//
// This is the foundation of the persistent-process agent model. Instead of
// spawning `grok --prompt-file … --output-format streaming-json` once PER TURN
// (which exits every turn and forces a per-turn `--resume`, the entire source of
// the resume pain), we launch ONE long-lived agent that speaks the Agent Client
// Protocol (ACP, JSON-RPC 2.0 over stdio) and drive it turn-by-turn:
//
//   spawn once → `initialize` → `session/new` (or `session/load` to RESTORE a
//   prior session's context on a (re)start) → then, per turn, `session/prompt`
//   and await the turn's completion, KEEPING THE PROCESS ALIVE between turns.
//
// Resume now happens ONLY at (re)start via `session/load` — exactly as the user
// asked ("Resume only when we restart the session").
//
// Wire protocol (reverse-engineered against grok 1.0.13; frames captured in the
// shipping report):
//   - Framing: line-delimited JSON-RPC 2.0 (mirrors StdioMcpClient in
//     src/mcpEmailTest.ts). NOT LSP Content-Length.
//   - initialize  {protocolVersion:1, clientCapabilities:{}} ->
//                 {protocolVersion, agentCapabilities:{loadSession:true,…}}
//   - session/new {cwd, mcpServers:[]}  -> {sessionId, models:{…}}
//     (grok STILL loads its own config MCP servers — mcp_initialized fires even
//      with mcpServers:[], so office/operate MCP keeps working.)
//   - session/load {sessionId, cwd, mcpServers:[]} -> replays the conversation as
//     session/update notifications, then resolves — restores in-process context.
//   - session/prompt {sessionId, prompt:[{type:'text',text}]} ->
//                 {stopReason:'end_turn'|'cancelled'|…, _meta:{usage,…}}  (the
//                 turn-end signal: resolves at turn end).
//   - session/update NOTIFICATIONS stream during a turn:
//       agent_message_chunk {content:{type:'text',text}}   -> assistant narration
//       tool_call           {toolCallId,title,rawInput}     -> PreToolUse
//       tool_call_update     {toolCallId,status:'completed',…} -> PostToolUse
//   - session/cancel {sessionId}  (notification) cancels the running turn; the
//     process STAYS ALIVE (a later prompt returns normally). Used for stop.
//   - A second session/prompt sent mid-turn is QUEUED by grok (FIFO) and run
//     after the current turn — this is how a mid-run STEER reaches the live
//     process without exiting it.
//
// With `--always-approve` grok never sends session/request_permission, and with
// EMPTY client capabilities grok performs its own fs/terminal I/O (verified) —
// so the client stays tiny. We still defensively answer any agent→client request.
// ---------------------------------------------------------------------------

import * as child_process from 'child_process';
import * as fs from 'fs';

/** Callbacks the host (tui.ts) injects so hook emission + redaction stay in one place. */
export interface AcpHostHooks {
  /** Emit ONE hook event to .autodev/hooks-events.jsonl (host adds redaction). */
  emitHook(name: string, extra: Record<string, unknown>): void;
  /** Human log line. */
  log(msg: string): void;
}

export interface AcpTurnResult {
  clean: boolean;
  stopReason: string;
  error?: string;
}

/** A decoded session/update notification (pure; unit-tested). */
export type AcpUpdate =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; outputText: string; status: string }
  | { kind: 'other' };

/**
 * Decode a raw JSON-RPC message that is a session/update notification into the
 * minimal shape the host maps to hooks. Returns {kind:'other'} for anything we
 * don't forward (queue/model/mcp/x.ai bookkeeping notifications, etc.). PURE.
 */
export function decodeAcpUpdate(msg: unknown): AcpUpdate {
  const m = msg as { method?: string; params?: { update?: Record<string, unknown> } };
  if (!m || m.method !== 'session/update' || !m.params || !m.params.update) { return { kind: 'other' }; }
  const u = m.params.update as Record<string, unknown>;
  const su = u['sessionUpdate'];
  if (su === 'agent_message_chunk') {
    const content = u['content'] as { type?: string; text?: string } | undefined;
    if (content && content.type === 'text' && typeof content.text === 'string') {
      return { kind: 'assistant', text: content.text };
    }
    return { kind: 'other' };
  }
  if (su === 'tool_call') {
    const id = String(u['toolCallId'] ?? '');
    // Prefer grok's real tool name from _meta['x.ai/tool'].name; fall back to title.
    const meta = (u['_meta'] as { ['x.ai/tool']?: { name?: string } } | undefined);
    const name = String(meta?.['x.ai/tool']?.name || u['title'] || '').trim();
    return { kind: 'tool_call', id, name, input: u['rawInput'] };
  }
  if (su === 'tool_call_update') {
    const status = String(u['status'] ?? '');
    if (status !== 'completed' && status !== 'failed') { return { kind: 'other' }; }
    const id = String(u['toolCallId'] ?? '');
    return { kind: 'tool_result', id, status, outputText: extractToolOutput(u) };
  }
  return { kind: 'other' };
}

/** Best-effort flatten of a tool_call_update's output into a short string. PURE. */
export function extractToolOutput(u: Record<string, unknown>): string {
  const raw = u['rawOutput'];
  if (typeof raw === 'string') { return raw; }
  if (raw && typeof raw === 'object') { try { return JSON.stringify(raw); } catch { /* ignore */ } }
  const content = u['content'];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      const cc = c as { type?: string; text?: string; newText?: string };
      if (cc?.type === 'text' && typeof cc.text === 'string') { parts.push(cc.text); }
      else if (cc?.type === 'diff' && typeof cc.newText === 'string') { parts.push(cc.newText); }
    }
    if (parts.length) { return parts.join('\n'); }
  }
  return '';
}

/**
 * Classify a session/prompt RESULT into clean-vs-error for the exit file. PURE.
 * - end_turn / max_tokens / max_turn_requests → clean (exit 0)
 * - cancelled → clean (an intentional interrupt, not a failure)
 * - a JSON-RPC error, or any other stopReason → error (exit 1)
 */
export function classifyAcpResult(result: { result?: { stopReason?: string }; error?: { message?: string } }): AcpTurnResult {
  if (result.error) { return { clean: false, stopReason: 'error', error: String(result.error.message || 'jsonrpc error') }; }
  const sr = String(result.result?.stopReason ?? '');
  const CLEAN = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'cancelled']);
  return { clean: CLEAN.has(sr), stopReason: sr || 'unknown' };
}

interface PendingRpc { resolve: (msg: { result?: Record<string, unknown>; error?: { message?: string } }) => void; }

/**
 * One persistent `grok agent stdio` process for a workspace root. Not exported as
 * a singleton — the host (tui.ts) keeps a Map<root, GrokAcpSession> and reuses it.
 */
export class GrokAcpSession {
  private readonly root: string;
  private readonly model: string | undefined;
  private readonly bin: string;
  private readonly hooks: AcpHostHooks;
  private readonly extraArgs: string[];

  private child: child_process.ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private _sessionId: string | undefined;
  private _wantSessionId: string | undefined; // id to session/load on (re)start
  private _ready: Promise<void> | null = null;
  private _busy = false;
  private _startCount = 0;
  private earlyStderr = '';

  /** The active PRIMARY turn's stdout sink (assistant text). Null between turns. */
  private _sink: ((text: string) => void) | null = null;
  /** Tool-call names by id, so a tool_result can carry the originating name. */
  private readonly _toolNames = new Map<string, string>();
  /** Accumulates assistant chunks so Notification hooks are line-granular, not
   *  per-token (grok streams a few chars per chunk — one bubble per token floods
   *  the office feed). Flushed on each newline and at turn end. */
  private _narrationBuf = '';

  constructor(opts: { root: string; model?: string; bin: string; hooks: AcpHostHooks; initialSessionId?: string; extraArgs?: string[] }) {
    this.root = opts.root;
    this.model = opts.model;
    this.bin = opts.bin;
    this.hooks = opts.hooks;
    this._wantSessionId = opts.initialSessionId;
    this.extraArgs = opts.extraArgs ?? [];
  }

  get pid(): number | undefined { return this.child?.pid; }
  get sessionId(): string | undefined { return this._sessionId; }
  isBusy(): boolean { return this._busy; }
  isAlive(): boolean { return !!this.child && this.child.exitCode === null && !this.child.killed; }

  /** Spawn + initialize + session/new|load, once. Respawns transparently if dead. */
  async ensureReady(): Promise<void> {
    if (this.isAlive() && this._sessionId) { return; }
    if (this._ready) { return this._ready; }
    this._ready = this._startup().catch((err) => { this._ready = null; throw err; });
    return this._ready;
  }

  private async _startup(): Promise<void> {
    this._spawnChild();
    await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    // Resume-on-(re)start: if a prior session id is known, session/load restores
    // its in-process context; on any failure, fall back to a fresh session/new.
    const want = this._wantSessionId;
    if (want) {
      try {
        const r = await this._request('session/load', { sessionId: want, cwd: this.root, mcpServers: [] });
        if (!r.error) {
          this._sessionId = want;
          this.hooks.log(`Grok ACP: restored session ${want.slice(0, 8)}… (session/load) — context intact`);
        }
      } catch (err) {
        this.hooks.log(`Grok ACP: session/load ${want.slice(0, 8)}… failed (${(err as Error)?.message ?? err}); starting fresh`);
      }
    }
    if (!this._sessionId) {
      const sn = await this._request('session/new', { cwd: this.root, mcpServers: [] });
      const sid = (sn.result as { sessionId?: string } | undefined)?.sessionId;
      if (!sid) { throw new Error('session/new returned no sessionId'); }
      this._sessionId = sid;
      this.hooks.log(`Grok ACP: new persistent session ${sid.slice(0, 8)}…`);
    }
    this._wantSessionId = this._sessionId;
    this.hooks.emitHook('SessionStart', { source: this._startCount > 1 ? 'resume' : 'startup' });
  }

  private _spawnChild(): void {
    this._startCount++;
    const args = ['agent', '--always-approve'];
    if (this.model) { args.push('-m', this.model); }
    args.push('--no-leader', ...this.extraArgs, 'stdio');
    const child = child_process.spawn(this.bin, args, {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: process.env['TERM'] || 'xterm-256color' },
    });
    this.child = child;
    this.buf = '';
    this.earlyStderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this._onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      if (this.earlyStderr.length < 4000) { this.earlyStderr += s; }
    });
    child.on('exit', (code, sig) => this._onExit(code, sig));
    child.on('error', (err) => this.hooks.log(`Grok ACP: child error: ${err.message}`));
  }

  private _onExit(code: number | null, sig: NodeJS.Signals | null): void {
    this.hooks.log(`Grok ACP: agent process exited (code=${code} sig=${sig})`);
    this.child = null;
    this._ready = null;
    this._sink = null;
    this._busy = false;
    // Reject any in-flight requests so an awaiting turn resolves (as an error) and
    // the loop can retry — the next turn respawns + session/load restores context.
    const err = { error: { message: `grok agent exited (code=${code} sig=${sig})` } };
    for (const [, p] of this.pending) { try { p.resolve(err); } catch { /* ignore */ } }
    this.pending.clear();
  }

  private _onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) { continue; }
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      this._handle(msg);
    }
  }

  private _handle(msg: Record<string, unknown>): void {
    const id = msg['id'];
    // Response to one of our requests.
    if (typeof id === 'number' && (msg['result'] !== undefined || msg['error'] !== undefined) && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      p.resolve(msg as { result?: Record<string, unknown>; error?: { message?: string } });
      return;
    }
    // Request FROM the agent (we are the client). With empty caps grok does its
    // own fs/terminal, but answer defensively so nothing ever wedges.
    if (msg['method'] && id !== undefined) {
      const method = String(msg['method']);
      if (method === 'session/request_permission') {
        const params = msg['params'] as { options?: Array<{ optionId?: string; kind?: string }> } | undefined;
        const opts = params?.options ?? [];
        const allow = opts.find((o) => /allow/i.test(o.optionId || o.kind || '')) || opts[0];
        this._send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } });
      } else {
        // Unknown/unsupported client method → tell grok to handle it itself.
        this._send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'client capability not provided' } });
      }
      return;
    }
    // Notification from the agent.
    if (msg['method'] === 'session/update') {
      this._onUpdate(decodeAcpUpdate(msg));
    }
  }

  private _onUpdate(u: AcpUpdate): void {
    if (u.kind === 'assistant') {
      if (this._sink) { try { this._sink(u.text); } catch { /* ignore */ } }
      this._narrationBuf += u.text;
      this._flushNarration(false);
      return;
    }
    if (u.kind === 'tool_call') {
      if (!u.name || u.name.startsWith('mcp__')) { return; } // office logs MCP tools server-side
      this._toolNames.set(u.id, u.name);
      this.hooks.emitHook('PreToolUse', { tool_name: u.name, tool_input: u.input, tool_use_id: u.id });
      return;
    }
    if (u.kind === 'tool_result') {
      const name = this._toolNames.get(u.id);
      if (!name) { return; } // no matching Pre (skipped mcp tool / replay) — don't emit orphan
      this._toolNames.delete(u.id);
      if (u.status === 'failed') {
        this.hooks.emitHook('PostToolUseFailure', { tool_name: name, tool_use_id: u.id, outcome: 'error', tool_output: { text: u.outputText.slice(0, 2000) } });
      } else {
        this.hooks.emitHook('PostToolUse', { tool_name: name, tool_use_id: u.id, tool_output: { text: u.outputText.slice(0, 2000) } });
      }
    }
  }

  /** Emit completed narration lines as Notification hooks. `final` flushes the
   *  trailing partial line (turn end). Keeps the office feed line-granular. */
  private _flushNarration(final: boolean): void {
    let nl: number;
    while ((nl = this._narrationBuf.indexOf('\n')) >= 0) {
      const line = this._narrationBuf.slice(0, nl);
      this._narrationBuf = this._narrationBuf.slice(nl + 1);
      if (line.trim()) { this.hooks.emitHook('Notification', { message: line, title: 'grok', tool_name: 'grok' }); }
    }
    if (final && this._narrationBuf.trim()) {
      this.hooks.emitHook('Notification', { message: this._narrationBuf, title: 'grok', tool_name: 'grok' });
    }
    if (final) { this._narrationBuf = ''; }
  }

  /**
   * Run ONE primary turn: send the prompt and await turn end. Streams assistant
   * text to `sink`. Emits Stop/StopFailure + SessionEnd via the host hooks. The
   * process stays alive afterward.
   */
  async runTurn(promptText: string, sink: (text: string) => void): Promise<AcpTurnResult> {
    await this.ensureReady();
    this._busy = true;
    this._sink = sink;
    let res: AcpTurnResult;
    try {
      const r = await this._request('session/prompt', {
        sessionId: this._sessionId,
        prompt: [{ type: 'text', text: promptText }],
      });
      res = classifyAcpResult(r);
    } catch (err) {
      res = { clean: false, stopReason: 'exception', error: (err as Error)?.message ?? String(err) };
    } finally {
      this._flushNarration(true);
      this._sink = null;
      this._busy = false;
    }
    if (res.clean) {
      this.hooks.emitHook('Stop', {});
      this.hooks.emitHook('SessionEnd', { reason: 'completed' });
    } else {
      this.hooks.emitHook('StopFailure', { exit_code: 1 });
      this.hooks.emitHook('SessionEnd', { reason: 'error' });
    }
    return res;
  }

  /**
   * Deliver a mid-run STEER to the LIVE process: send an additional
   * session/prompt that grok QUEUES (FIFO) and runs next — without exiting.
   * Returns true if handed to the live agent, false if no live session.
   */
  steer(text: string): boolean {
    if (!this.isAlive() || !this._sessionId) { return false; }
    const t = text.trim();
    if (!t) { return false; }
    // Fire-and-forget: resolves on its own promptId; we don't tie it to exitFile.
    this._request('session/prompt', { sessionId: this._sessionId, prompt: [{ type: 'text', text: t }] })
      .catch(() => { /* logged via exit handler if the child dies */ });
    return true;
  }

  /** Cancel the running turn (process stays alive). */
  cancel(): void {
    if (!this.isAlive() || !this._sessionId) { return; }
    this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } });
  }

  /** Kill the persistent process. Preserves the known session id for a later load. */
  close(): void {
    const c = this.child;
    this.child = null;
    this._ready = null;
    this._sink = null;
    this._busy = false;
    for (const [, p] of this.pending) { try { p.resolve({ error: { message: 'closed' } }); } catch { /* ignore */ } }
    this.pending.clear();
    if (c) {
      try { c.stdin?.end(); } catch { /* ignore */ }
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  private _request(method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      const ok = this._send({ jsonrpc: '2.0', id, method, params });
      if (!ok) { this.pending.delete(id); resolve({ error: { message: 'stdin write failed (agent not running)' } }); }
    });
  }

  private _send(obj: unknown): boolean {
    const c = this.child;
    if (!c || !c.stdin || c.stdin.destroyed) { return false; }
    try { c.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  get stderrSnapshot(): string { return this.earlyStderr; }
}
