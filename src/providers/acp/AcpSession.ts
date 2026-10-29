// ---------------------------------------------------------------------------
// AcpSession — a PROVIDER-AGNOSTIC persistent Agent Client Protocol process.
//
// This is the generalization of the grok-only GrokAcpSession (shipped 1.4.188)
// into a single client that can drive ANY agent that speaks ACP over stdio —
// grok (`grok agent … stdio`), opencode (`opencode acp`), and later copilot
// (`copilot --acp`) / claude (via a third-party adapter). One long-lived process
// per workspace root, fed turn-by-turn, kept alive between turns:
//
//   spawn once → `initialize` → `session/new` (or `session/load` to RESTORE a
//   prior session's context at (re)start) → per turn `session/prompt`, awaiting
//   the turn's completion, KEEPING THE PROCESS ALIVE between turns.
//
// Wire protocol (identical across grok + opencode; captured live against
// grok 1.0.13 and opencode 1.14.22):
//   - Framing: line-delimited JSON-RPC 2.0 (NOT LSP Content-Length).
//   - initialize  {protocolVersion:1, clientCapabilities:{}} ->
//                 {protocolVersion, agentCapabilities:{loadSession, sessionCapabilities:{resume,…}}}
//   - session/new {cwd, mcpServers:[]}  -> {sessionId, …}
//     (the agent STILL loads its OWN config MCP servers even with mcpServers:[],
//      so office/operate MCP keeps working — verified for grok AND opencode.)
//   - session/load {sessionId, cwd, mcpServers:[]} -> replays the conversation as
//     session/update notifications, then resolves — restores in-process context.
//   - session/prompt {sessionId, prompt:[{type:'text',text}]} ->
//                 {stopReason:'end_turn'|'cancelled'|…}  (resolves at turn end).
//   - session/update NOTIFICATIONS stream during a turn (agent_message_chunk,
//     agent_thought_chunk, tool_call, tool_call_update, …).
//   - session/cancel {sessionId} (notification) cancels the running turn; the
//     process STAYS ALIVE. A second session/prompt mid-turn is QUEUED (FIFO) by
//     the agent and run after the current turn — this is how a mid-run STEER
//     reaches the live process without exiting it.
//
// With EMPTY client capabilities the agent performs its OWN fs/terminal I/O
// (verified for grok + opencode) — so the client stays tiny. We still answer any
// agent→client request defensively (auto-allow permission) so nothing wedges.
//
// The ONLY provider-specific bits are captured in `AcpLaunchSpec`:
//   - buildArgs(model, extra): the argv after the binary
//     (grok: `agent --always-approve [-m M] --no-leader … stdio`;
//      opencode: `[-m M] acp`)
//   - decodeUpdate: how this provider's session/update maps to AcpUpdate
//     (grok reads the real tool name from `_meta['x.ai/tool']`; opencode uses the
//      standard ACP `title`) — defaults to the standard-ACP decoder below.
//   - narrationTitle: the label attached to narration hooks ('grok' / 'opencode').
//   - narrateReasoning: whether agent_thought_chunk is forwarded as narration
//     (default false — keeps reasoning out of the office chat).
// ---------------------------------------------------------------------------

import * as child_process from 'child_process';

/** Callbacks the host injects so hook emission + redaction stay in one place. */
export interface AcpHostHooks {
  /** Emit ONE hook event (host adds redaction + provider tagging). */
  emitHook(name: string, extra: Record<string, unknown>): void;
  /** Human log line. */
  log(msg: string): void;
}

export interface AcpTurnResult {
  clean: boolean;
  stopReason: string;
  error?: string;
  /** True when the turn ended clean but produced NO assistant text / tool calls
   *  (e.g. an unusable model). Lets the host surface a clear log instead of
   *  silently spinning. */
  emptyOutput?: boolean;
}

/** A decoded session/update notification (pure; unit-tested). */
export type AcpUpdate =
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; outputText: string; status: string }
  | { kind: 'other' };

/** Provider-specific launch + decode configuration. */
export interface AcpLaunchSpec {
  /** Build the argv (after the binary) for `spawn`. */
  buildArgs(model: string | undefined, extraArgs: string[]): string[];
  /** Decode a raw JSON-RPC session/update into an AcpUpdate. Defaults to the
   *  standard-ACP decoder (`decodeAcpUpdateStandard`). */
  decodeUpdate?: (msg: unknown) => AcpUpdate;
  /** Title attached to narration (Notification) hooks. */
  narrationTitle: string;
  /** Forward agent_thought_chunk as narration too (default false). */
  narrateReasoning?: boolean;
  /** This agent requires an explicit `authenticate` before session/new|load
   *  (grok ≥1.0.41 does: `initialize` advertises `authMethods` and session/new
   *  otherwise fails "Authentication required: no auth method id provided").
   *  When true AND the agent advertises auth methods but none is usable
   *  headlessly, startup throws a clear reauth error instead of hanging on an
   *  interactive sign-in. Agents that don't gate on auth (opencode) leave it
   *  false; the authenticate call is still made when a non-interactive method is
   *  advertised, and skipped entirely when none is. */
  authRequired?: boolean;
}

/**
 * STANDARD-ACP decoder (opencode, and the generic default). Handles the ACP-spec
 * session/update shapes:
 *   agent_message_chunk {content:{type:'text',text}}       -> assistant
 *   agent_thought_chunk {content:{type:'text',text}}       -> reasoning
 *   tool_call           {toolCallId,title,rawInput}        -> tool_call (name=title)
 *   tool_call_update    {toolCallId,status,content|rawOutput} -> tool_result
 * Anything else (available_commands_update, usage_update, plan, …) -> other. PURE.
 */
export function decodeAcpUpdateStandard(msg: unknown): AcpUpdate {
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
  if (su === 'agent_thought_chunk') {
    const content = u['content'] as { type?: string; text?: string } | undefined;
    if (content && content.type === 'text' && typeof content.text === 'string') {
      return { kind: 'reasoning', text: content.text };
    }
    return { kind: 'other' };
  }
  if (su === 'tool_call') {
    const id = String(u['toolCallId'] ?? '');
    // Standard ACP puts a human title on the tool call; some agents also carry a
    // machine tool id under _meta — prefer an explicit name, fall back to title.
    const meta = u['_meta'] as Record<string, unknown> | undefined;
    const metaName = _metaToolName(meta);
    const name = String(metaName || u['title'] || u['kind'] || '').trim();
    return { kind: 'tool_call', id, name, input: u['rawInput'] };
  }
  if (su === 'tool_call_update') {
    const status = String(u['status'] ?? '');
    // Only TERMINAL statuses close a tool call; in_progress/pending are interim.
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') { return { kind: 'other' }; }
    const id = String(u['toolCallId'] ?? '');
    return { kind: 'tool_result', id, status, outputText: extractToolOutput(u) };
  }
  return { kind: 'other' };
}

/** Pull a machine tool name out of a provider `_meta` blob if present. PURE. */
function _metaToolName(meta: Record<string, unknown> | undefined): string {
  if (!meta || typeof meta !== 'object') { return ''; }
  // grok: _meta['x.ai/tool'].name ; opencode: _meta['opencode']?.tool (defensive)
  const xai = meta['x.ai/tool'] as { name?: string } | undefined;
  if (xai?.name) { return String(xai.name); }
  const oc = meta['opencode'] as { tool?: string; toolID?: string } | undefined;
  if (oc?.tool || oc?.toolID) { return String(oc.tool || oc.toolID); }
  return '';
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
      const cc = c as { type?: string; text?: string; newText?: string; content?: { text?: string } };
      if (cc?.type === 'text' && typeof cc.text === 'string') { parts.push(cc.text); }
      else if (cc?.type === 'diff' && typeof cc.newText === 'string') { parts.push(cc.newText); }
      else if (cc?.content && typeof cc.content.text === 'string') { parts.push(cc.content.text); }
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
 * One persistent ACP process for a workspace root. Not a singleton — the host
 * keeps a Map<root, AcpSession> and reuses it. Provider behaviour is injected via
 * the `spec`.
 */
export class AcpSession {
  protected readonly root: string;
  protected readonly model: string | undefined;
  protected readonly bin: string;
  protected readonly hooks: AcpHostHooks;
  protected readonly extraArgs: string[];
  protected readonly spec: AcpLaunchSpec;
  /** Extra env vars merged into the child's environment (e.g. OPENCODE_CONFIG). */
  protected readonly extraEnv: Record<string, string>;
  private readonly _decode: (msg: unknown) => AcpUpdate;
  /** LEADER attach-without-load (Layer B, 1.4.193): when true and a candidate
   *  session id is known, adopt it DIRECTLY at (re)start — no session/load, no
   *  history replay — because a live keepalive client holds the session warm in
   *  the leader's memory. Default false ⇒ the pre-1.4.193 session/load path is
   *  used byte-for-byte (zero behaviour change when leader mode is off). */
  private readonly _attachWithoutLoad: boolean;

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
  /** True WHILE session/load is replaying prior history — every session/update
   *  during the replay is dropped (emits ZERO hooks) so a (re)start never
   *  re-spams historical narration + tool_calls to the office feed (Layer A.1). */
  private _loading = false;

  /** The active PRIMARY turn's stdout sink (assistant text). Null between turns. */
  private _sink: ((text: string) => void) | null = null;
  /** Tool-call names by id, so a tool_result can carry the originating name. */
  private readonly _toolNames = new Map<string, string>();
  /** Accumulates assistant chunks so Notification hooks are line-granular. */
  private _narrationBuf = '';
  /** The current tool activity label (set on tool_call, cleared on result). */
  private _activity: string | undefined;
  /** Did the active turn produce ANY assistant text or tool call? (empty-turn guard) */
  private _turnHadOutput = false;
  /** Timestamp (ms) of the LAST agent activity this turn — bumped on every
   *  session/update (tool_call, tool_call_update, message/thought chunk, plan).
   *  The activity-based watchdog (runTurn) reads this: a turn that keeps producing
   *  activity is healthy no matter how long it runs; only TOTAL SILENCE for the
   *  idle window is a stall. */
  private _lastActivityAt = 0;
  /** True when the session was just session/load-RESTORED and its first turn has
   *  not yet produced any activity — armed in _startup, cleared on the first real
   *  _onUpdate. runTurn uses it to apply the short resume-first-activity deadline. */
  private _resumeNeedsVerify = false;
  /** ALL outstanding session/prompt promises — the primary turn AND any steered
   *  (queued) continuation prompts. The turn is not "done" until this drains, so
   *  the loop keeps the agent WORKING through steers instead of going idle while
   *  the agent runs an untracked queued turn (Bug A). */
  private readonly _inflight = new Set<Promise<{ result?: Record<string, unknown>; error?: { message?: string } }>>();

  constructor(opts: {
    root: string; model?: string; bin: string; hooks: AcpHostHooks;
    spec: AcpLaunchSpec; initialSessionId?: string; extraArgs?: string[];
    extraEnv?: Record<string, string>; attachWithoutLoad?: boolean;
  }) {
    this.root = opts.root;
    this.model = opts.model;
    this.bin = opts.bin;
    this.hooks = opts.hooks;
    this.spec = opts.spec;
    this._decode = opts.spec.decodeUpdate ?? decodeAcpUpdateStandard;
    this._wantSessionId = opts.initialSessionId;
    this.extraArgs = opts.extraArgs ?? [];
    this.extraEnv = opts.extraEnv ?? {};
    this._attachWithoutLoad = opts.attachWithoutLoad ?? false;
  }

  /** ACTIVITY-BASED watchdog IDLE window (ms). The per-turn watchdog is RESET on
   *  ANY agent session/update this turn (tool_call, tool_call_update, agent_message
   *  /thought chunk, plan updates — see `_bumpActivity`), so a legitimately LONG,
   *  actively-WORKING turn (e.g. a QA pass firing dozens of search_replace/read_file
   *  tool calls) runs as long as it keeps making progress. Only a TRUE STALL — no
   *  activity at all for this whole window — cancels + reconnects.
   *
   *  This replaces the old TOTAL-runtime cap (1.4.194 and earlier), which wrongly
   *  killed active long turns ("timing out too early, the agent is working").
   *
   *  Env, first set wins: AUTODEV_ACP_IDLE_MS (preferred), else the legacy per-turn
   *  caps AUTODEV_ACP_MAX_RUN_MS / GROK_MAX_RUN_MS (now REINTERPRETED as the idle
   *  window — back-compat: a value that used to be a runtime cap is still a safe,
   *  strictly-more-permissive idle window), else 15 minutes. A 0/negative value
   *  disables the idle guard.
   *
   *  Default 15 min: observed real stalls (grok `waiting_for_model` hang with no
   *  output) were ~2.5 min, so 15 minutes of TOTAL SILENCE is unambiguously a hang
   *  and never a working turn, while still bounding a genuine wedge. */
  static idleMs(): number {
    const raw = process.env['AUTODEV_ACP_IDLE_MS'] ?? process.env['AUTODEV_ACP_MAX_RUN_MS'] ?? process.env['GROK_MAX_RUN_MS'] ?? '';
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) { return n; }
    if (Number.isFinite(n) && n <= 0 && String(raw).trim() !== '') { return 2147483647; } // disabled
    return 15 * 60 * 1000;
  }

  /** Absolute per-turn CEILING (ms) — a hard stop regardless of activity, as a last
   *  resort. OFF by default (0): the idle window above is the real guard, so a
   *  productive turn is NEVER killed on wall-clock alone. Set AUTODEV_ACP_ABS_MAX_MS
   *  to a large value (e.g. hours) only if a hard cap is genuinely wanted. */
  static absMaxMs(): number {
    const raw = process.env['AUTODEV_ACP_ABS_MAX_MS'] ?? '';
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) { return n; }
    return 0; // disabled — idle timeout is the guard
  }

  /** @deprecated back-compat shim — the watchdog is now activity-based (idle
   *  timeout). Returns the idle window so any external caller keeps working. */
  static maxRunMs(): number { return AcpSession.idleMs(); }

  /** FIRST-ACTIVITY deadline (ms) for the first turn on a freshly session/load-
   *  RESTORED session. Grok sometimes hangs in `waiting_for_model` right after a
   *  session/load (resume) and produces NO activity at all — a true stall that the
   *  15-min idle watchdog would only catch after 15 min. So the first turn after a
   *  resume gets this MUCH shorter deadline: if it has produced ZERO activity by
   *  then, treat the resume as poisoned, drop it, and recover with a fresh
   *  session/new. Only the FIRST post-resume turn is subject to it; once any
   *  activity lands the session is proven healthy and the normal idle watchdog
   *  takes over. 0/negative disables it. Default 90s. */
  static resumeFirstActivityMs(): number {
    const raw = process.env['AUTODEV_ACP_RESUME_FIRST_ACTIVITY_MS'] ?? '';
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) { return n; }
    if (Number.isFinite(n) && n <= 0 && String(raw).trim() !== '') { return 0; } // disabled
    return 90 * 1000;
  }

  /** PURE watchdog verdict, extracted so the activity-reset logic is unit-testable
   *  deterministically without real timers. Cancels iff there has been NO agent
   *  activity for the whole idle window (a true stall), OR — when an absolute
   *  ceiling is enabled — the turn has run past it. */
  static watchdogVerdict(p: {
    now: number; lastActivityAt: number; turnStart: number; idleMs: number; absMs: number;
  }): { cancel: boolean; reason: string } {
    if (p.idleMs > 0) {
      const idleFor = p.now - p.lastActivityAt;
      if (idleFor >= p.idleMs) {
        return { cancel: true, reason: `idle/stalled — no agent activity for ${Math.round(idleFor / 1000)}s (idle window ${Math.round(p.idleMs / 1000)}s)` };
      }
    }
    if (p.absMs > 0) {
      const ranFor = p.now - p.turnStart;
      if (ranFor >= p.absMs) {
        return { cancel: true, reason: `absolute ceiling ${Math.round(p.absMs / 1000)}s exceeded (ran ${Math.round(ranFor / 1000)}s)` };
      }
    }
    return { cancel: false, reason: '' };
  }

  /** Reset the watchdog: record that the agent just made progress. Called on every
   *  session/update (past the loading-replay guard). */
  private _bumpActivity(): void { this._lastActivityAt = Date.now(); }

  /** Grace window (ms) to wait for a TRAILING agent_message_chunk after a clean
   *  end_turn before declaring the turn empty. gpt-oss:20b (and some slow local
   *  models) can emit their FINAL chunk a beat after end_turn resolves; without
   *  this grace the loop reads _turnHadOutput===false and flags a spuriously-empty
   *  turn. Bounded + only consumed when a clean turn has produced nothing yet, so
   *  it never adds latency to a normal turn. Env: AUTODEV_ACP_TRAILING_CHUNK_MS
   *  (0/negative disables the grace). Default 600ms. */
  static trailingChunkGraceMs(): number {
    const raw = process.env['AUTODEV_ACP_TRAILING_CHUNK_MS'] ?? '';
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) { return n; }
    if (Number.isFinite(n) && n <= 0 && String(raw).trim() !== '') { return 0; } // disabled
    return 600;
  }

  get pid(): number | undefined { return this.child?.pid; }
  get sessionId(): string | undefined { return this._sessionId; }
  get activity(): string | undefined { return this._activity; }
  /** Busy while the primary turn is running OR any steered/queued prompt is still
   *  in-flight — so the loop never treats the agent as idle mid-queue (Bug A). */
  isBusy(): boolean { return this._busy || this._inflight.size > 0; }
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
    const init = await this._request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await this._authenticate(init);
    const want = this._wantSessionId;
    if (want && this._attachWithoutLoad) {
      // Layer B (1.4.193): a live keepalive client holds this session warm in the
      // leader's memory, so ATTACH DIRECTLY — set the id, NO session/load, NO replay.
      // Verify / rediscover via session/list (the persisted id may be stale while a
      // cwd-matching live session exists); optimistic otherwise — a truly-dead id
      // fails the first prompt and the host runs its leader poison-escape.
      const chosen = await this._rediscoverLiveSession(want);
      this._sessionId = chosen;
      this.hooks.log(`ACP: attached to live leader session ${chosen.slice(0, 8)}… (no session/load) — context warm`);
    } else if (want) {
      // Layer A.1: suppress hook emission for the whole session/load replay so a
      // reload restores context QUIETLY (no re-spammed historical narration/tools).
      this._loading = true;
      try {
        const r = await this._request('session/load', { sessionId: want, cwd: this.root, mcpServers: [] });
        if (!r.error) {
          this._sessionId = want;
          // A restored session's FIRST turn gets the short resume-first-activity
          // deadline (grok can hang in waiting_for_model after a session/load).
          this._resumeNeedsVerify = true;
          this.hooks.log(`ACP: restored session ${want.slice(0, 8)}… (session/load, quiet) — context intact`);
        }
      } catch (err) {
        this.hooks.log(`ACP: session/load ${want.slice(0, 8)}… failed (${(err as Error)?.message ?? err}); starting fresh`);
      } finally {
        this._loading = false;
        this._narrationBuf = '';   // drop any partial replayed narration
        this._toolNames.clear();   // drop replayed open tool ids (never emitted)
      }
    }
    if (!this._sessionId) {
      const sn = await this._request('session/new', { cwd: this.root, mcpServers: [] });
      const sid = (sn.result as { sessionId?: string } | undefined)?.sessionId;
      if (!sid) {
        const em = sn.error?.message ? ` (${sn.error.message})` : '';
        throw new Error(`session/new returned no sessionId${em}`);
      }
      this._sessionId = sid;
      this.hooks.log(`ACP: new persistent session ${sid.slice(0, 8)}…`);
    }
    this._wantSessionId = this._sessionId;
    this.hooks.emitHook('SessionStart', { source: this._startCount > 1 ? 'resume' : 'startup' });
  }

  /**
   * Headless ACP authentication. grok ≥1.0.41 advertises `authMethods` from
   * `initialize` and REQUIRES `authenticate({ methodId, _meta:{headless:true} })`
   * before session/new|load — otherwise session/new fails with
   * "Authentication required: no auth method id provided". We pick a
   * NON-INTERACTIVE method so this never opens a browser and hangs:
   *   1. an API-key method (`xai.api_key` / `*api_key*`) when XAI_API_KEY or
   *      GROK_API_KEY is set,
   *   2. else a cached-token method (`cached_token` / `*cached*`, present once the
   *      user has logged in via `grok login`),
   *   3. else, when the agent gates on auth (`spec.authRequired`) and only an
   *      interactive method (e.g. `grok.com` sign-in) is offered, throw a clear
   *      reauth error instead of hanging. `_meta.headless:true` keeps the chosen
   *      method non-interactive. Agents that advertise NO auth methods (opencode)
   *      skip this entirely, so this is safe for every AcpSession consumer.
   */
  private async _authenticate(
    init: { result?: Record<string, unknown>; error?: { message?: string } },
  ): Promise<void> {
    const methods = ((init?.result?.['authMethods'] as Array<{ id?: string }> | undefined) ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string');
    if (methods.length === 0) { return; }   // nothing to authenticate (e.g. opencode)
    const hasKey = !!(process.env['XAI_API_KEY'] || process.env['GROK_API_KEY']);
    const methodId =
      (hasKey ? methods.find((m) => m.includes('api_key')) : undefined)
      ?? methods.find((m) => m === 'cached_token' || m.includes('cached'))
      ?? (hasKey ? methods.find((m) => m.includes('api_key')) : undefined);
    if (!methodId) {
      if (this.spec.authRequired) {
        throw new Error(
          `ACP: no non-interactive auth method available (advertised: ${methods.join(', ')}). `
          + 'Set XAI_API_KEY, or run `grok login` so a cached token is offered.',
        );
      }
      return;   // non-gating agent offering only interactive methods — best-effort skip
    }
    const r = await this._request('authenticate', { methodId, _meta: { headless: true } });
    if (r.error) {
      throw new Error(`ACP: authenticate(${methodId}) failed: ${r.error.message ?? 'unknown error'}`);
    }
    this.hooks.log(`ACP: authenticated via ${methodId}`);
  }

  /** True when this session is in LEADER attach-without-load mode. */
  get attachMode(): boolean { return this._attachWithoutLoad; }

  /**
   * Does a JSON-RPC error message look like the leader rejecting our attach id
   * (session evicted / never existed on this leader)? Used by the host to trigger
   * the leader poison-escape. PURE.
   */
  static isUnknownSessionError(msg: string | undefined): boolean {
    return /unknown session id|no such session|session not found|invalid session|unknown session/i.test(String(msg ?? ''));
  }

  /**
   * Best-effort: confirm `want` is a live session on the leader (session/list), or
   * rediscover the session for this cwd if the persisted id is stale. Returns the
   * id to attach to (falls back to `want` when session/list is unavailable). PURE
   * of side effects beyond the one JSON-RPC read.
   */
  private async _rediscoverLiveSession(want: string): Promise<string> {
    try {
      const r = await this._request('session/list', {});
      const sessions = (r.result as { sessions?: Array<{ sessionId?: string; cwd?: string }> } | undefined)?.sessions;
      if (Array.isArray(sessions) && sessions.length) {
        if (sessions.some((s) => s?.sessionId === want)) { return want; }
        const cwdMatch = sessions.find((s) => s?.cwd === this.root && s?.sessionId);
        if (cwdMatch?.sessionId) {
          this.hooks.log(`ACP: persisted id stale; rediscovered cwd session ${cwdMatch.sessionId.slice(0, 8)}… via session/list`);
          return cwdMatch.sessionId;
        }
      }
    } catch { /* session/list unsupported → optimistic attach */ }
    return want;
  }

  private _spawnChild(): void {
    this._startCount++;
    const args = this.spec.buildArgs(this.model, this.extraArgs);
    const child = child_process.spawn(this.bin, args, {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: process.env['TERM'] || 'xterm-256color', ...this.extraEnv },
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
    child.on('error', (err) => this.hooks.log(`ACP: child error: ${err.message}`));
  }

  private _onExit(code: number | null, sig: NodeJS.Signals | null): void {
    this.hooks.log(`ACP: agent process exited (code=${code} sig=${sig})`);
    this.child = null;
    this._ready = null;
    this._sink = null;
    this._busy = false;
    this._activity = undefined;
    this._flushOpenTools('interrupted'); // Bug B: close any tools open when the agent dies
    const err = { error: { message: `acp agent exited (code=${code} sig=${sig})` } };
    for (const [, p] of this.pending) { try { p.resolve(err); } catch { /* ignore */ } }
    this.pending.clear();
    this._inflight.clear();
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
    if (typeof id === 'number' && (msg['result'] !== undefined || msg['error'] !== undefined) && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      p.resolve(msg as { result?: Record<string, unknown>; error?: { message?: string } });
      return;
    }
    // Request FROM the agent (we are the client). With empty caps the agent does
    // its own fs/terminal, but answer defensively so nothing ever wedges.
    if (msg['method'] && id !== undefined) {
      const method = String(msg['method']);
      if (method === 'session/request_permission') {
        const params = msg['params'] as { options?: Array<{ optionId?: string; kind?: string }> } | undefined;
        const opts = params?.options ?? [];
        const allow = opts.find((o) => /allow|once|always/i.test(o.optionId || o.kind || '')) || opts[0];
        this._send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } });
      } else {
        this._send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'client capability not provided' } });
      }
      return;
    }
    if (msg['method'] === 'session/update') {
      this._onUpdate(this._decode(msg));
    }
  }

  private _onUpdate(u: AcpUpdate): void {
    if (this._loading) { return; } // Layer A.1: drop session/load replay silently
    this._bumpActivity(); // any live update = the turn is progressing → reset the idle watchdog
    this._resumeNeedsVerify = false; // real activity ⇒ the resume is healthy; drop the short deadline
    if (u.kind === 'assistant') {
      this._turnHadOutput = true;
      if (this._sink) { try { this._sink(u.text); } catch { /* ignore */ } }
      this._narrationBuf += u.text;
      this._flushNarration(false);
      return;
    }
    if (u.kind === 'reasoning') {
      if (!this.spec.narrateReasoning) { return; } // reasoning kept out of the feed by default
      this._narrationBuf += u.text;
      this._flushNarration(false);
      return;
    }
    if (u.kind === 'tool_call') {
      if (!u.name || u.name.startsWith('mcp__')) { return; } // office logs MCP tools server-side
      this._turnHadOutput = true;
      this._activity = u.name;
      this._toolNames.set(u.id, u.name);
      this.hooks.emitHook('PreToolUse', { tool_name: u.name, tool_input: u.input, tool_use_id: u.id });
      return;
    }
    if (u.kind === 'tool_result') {
      const name = this._toolNames.get(u.id);
      if (!name) { return; } // no matching Pre (skipped mcp tool / replay) — don't emit orphan
      this._toolNames.delete(u.id);
      this._activity = undefined;
      if (u.status === 'failed' || u.status === 'cancelled') {
        this.hooks.emitHook('PostToolUseFailure', { tool_name: name, tool_use_id: u.id, outcome: u.status === 'cancelled' ? 'cancelled' : 'error', tool_output: { text: u.outputText.slice(0, 2000) } });
      } else {
        this.hooks.emitHook('PostToolUse', { tool_name: name, tool_use_id: u.id, tool_output: { text: u.outputText.slice(0, 2000) } });
      }
    }
  }

  /**
   * Bug B invariant: every forwarded tool-START must get a matching tool-END. On
   * turn end / cancel / teardown, FLUSH any tool_call ids still open (never got a
   * terminal tool_call_update) as ended, so pixel-office (which pairs start→end)
   * never shows a tool stuck "running" after the agent is idle.
   */
  private _flushOpenTools(outcome: string): void {
    if (this._toolNames.size === 0) { return; }
    for (const [id, name] of this._toolNames) {
      try {
        this.hooks.emitHook('PostToolUseFailure', { tool_name: name, tool_use_id: id, outcome, tool_output: { text: `[${outcome}]` } });
      } catch { /* ignore */ }
    }
    this._toolNames.clear();
    this._activity = undefined;
  }

  /** Emit completed narration lines as Notification hooks. `final` flushes the
   *  trailing partial line (turn end). Keeps the office feed line-granular. */
  private _flushNarration(final: boolean): void {
    let nl: number;
    while ((nl = this._narrationBuf.indexOf('\n')) >= 0) {
      const line = this._narrationBuf.slice(0, nl);
      this._narrationBuf = this._narrationBuf.slice(nl + 1);
      if (line.trim()) { this.hooks.emitHook('Notification', { message: line, title: this.spec.narrationTitle, tool_name: this.spec.narrationTitle }); }
    }
    if (final && this._narrationBuf.trim()) {
      this.hooks.emitHook('Notification', { message: this._narrationBuf, title: this.spec.narrationTitle, tool_name: this.spec.narrationTitle });
    }
    if (final) { this._narrationBuf = ''; }
  }

  /**
   * Run ONE primary turn: send the prompt and await turn end. Streams assistant
   * text to `sink`. Emits Stop/StopFailure + SessionEnd. The process stays alive.
   */
  async runTurn(promptText: string, sink: (text: string) => void): Promise<AcpTurnResult> {
    await this.ensureReady();
    this._busy = true;
    this._sink = sink;
    this._turnHadOutput = false;
    // Layer A.3 (1.4.195): ACTIVITY-BASED per-turn watchdog. A wedged always-open
    // turn must never hang the loop forever — BUT a legitimately LONG, actively-
    // WORKING turn (dozens of tool calls over 20+ min) must never be cancelled
    // either (the 1.4.194 TOTAL-runtime cap wrongly did: "timing out too early, the
    // agent is working"). So this is an IDLE timeout: it is reset on ANY agent
    // activity (`_bumpActivity` in `_onUpdate`) and only fires after a full idle
    // window of TOTAL SILENCE — a true stall. An absolute ceiling (off by default)
    // is a last-resort hard cap only. On fire we cancel + reconnect and surface it
    // as a FAILURE (never a false success); durable steers survive the reconnect.
    const idleMs = AcpSession.idleMs();
    const absMs = AcpSession.absMaxMs();
    const turnStart = Date.now();
    this._bumpActivity(); // arm: the turn has just started (counts as activity)
    let timedOut = false;
    let timeoutReason = '';
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<'timeout'>((resolve) => {
      const bothOff = !(idleMs > 0) && !(absMs > 0);
      if (bothOff) { return; } // watchdog fully disabled → never fires
      const tick = (): void => {
        const now = Date.now();
        const v = AcpSession.watchdogVerdict({ now, lastActivityAt: this._lastActivityAt, turnStart, idleMs, absMs });
        if (v.cancel) { timedOut = true; timeoutReason = v.reason; resolve('timeout'); return; }
        // Not yet — re-arm for the SOONER of (idle window since last activity) and
        // (absolute ceiling since turn start). Any activity that arrives meanwhile
        // has already pushed `_lastActivityAt` forward, so the next tick finds the
        // turn healthy and the idle countdown effectively restarts.
        const untilIdle = idleMs > 0 ? (this._lastActivityAt + idleMs) - now : Number.MAX_SAFE_INTEGER;
        const untilAbs = absMs > 0 ? (turnStart + absMs) - now : Number.MAX_SAFE_INTEGER;
        const next = Math.min(untilIdle, untilAbs);
        timer = setTimeout(tick, Math.max(50, Math.min(next, 2147483647)));
      };
      const first = idleMs > 0 ? idleMs : absMs;
      timer = setTimeout(tick, Math.max(50, Math.min(first, 2147483647)));
    });
    // FIRST-ACTIVITY deadline for a freshly session/load-RESTORED session: if this
    // resume's first turn produces ZERO activity within resumeMs, the resume is
    // poisoned (grok waiting_for_model hang) — drop it so the caller recovers with a
    // fresh session/new, instead of waiting out the 15-min idle watchdog.
    let resumeTimer: NodeJS.Timeout | undefined;
    const resumeMs = AcpSession.resumeFirstActivityMs();
    const resumeDeadline = new Promise<'resume-stall'>((resolve) => {
      if (!this._resumeNeedsVerify || resumeMs <= 0) { return; } // not a resume-verify turn → never fires
      resumeTimer = setTimeout(() => { if (this._resumeNeedsVerify) { resolve('resume-stall'); } }, resumeMs);
    });
    let res: AcpTurnResult;
    try {
      const outcome = await Promise.race([
        (async (): Promise<AcpTurnResult> => {
          const r = await this._promptRequest(promptText);
          const c = classifyAcpResult(r);
          // Bug A: drain any STEERED (queued) continuation prompts before declaring
          // the turn done — the agent stays WORKING until the ACP queue is empty.
          try { await this._drainInflight(); } catch { /* resolve on exit */ }
          return c;
        })(),
        watchdog,
        resumeDeadline,
      ]);
      if (outcome === 'timeout') {
        this.hooks.log(`ACP: turn watchdog fired — ${timeoutReason} — cancelling + reconnecting`);
        try { this.cancel(); } catch { /* ignore */ }
        try { this.close(); } catch { /* ignore */ } // next turn respawns + session/load restores context
        res = { clean: false, stopReason: 'timeout', error: `turn watchdog: ${timeoutReason}` };
      } else if (outcome === 'resume-stall') {
        this.hooks.log(`ACP: resume stall — no activity ${resumeMs}ms after session/load (grok waiting_for_model hang); dropping the poisoned session for a fresh start`);
        try { this.cancel(); } catch { /* ignore */ }
        try { this.close(); } catch { /* ignore */ }
        res = { clean: false, stopReason: 'resume-stall', error: 'resumed session produced no activity within the first-activity deadline — poisoned resume dropped' };
      } else {
        res = outcome;
      }
    } catch (err) {
      res = { clean: false, stopReason: 'exception', error: (err as Error)?.message ?? String(err) };
    } finally {
      if (timer) { clearTimeout(timer); }
      if (resumeTimer) { clearTimeout(resumeTimer); }
    }
    // gpt-oss:20b empty-turn race: a clean end_turn can be followed a beat later
    // by the model's FINAL agent_message_chunk. If the turn ended clean but no
    // output has landed yet, briefly wait (bounded, polling the flag) for a
    // trailing chunk — done BEFORE nulling the sink so a late chunk still reaches
    // the sink + narration and flips _turnHadOutput. Minimal + safe for all
    // providers: skipped entirely when the turn already produced output, did not
    // end clean, or the grace is disabled.
    if (res.clean && !this._turnHadOutput) {
      const graceMs = AcpSession.trailingChunkGraceMs();
      const stepMs = 50;
      let waited = 0;
      while (waited < graceMs && !this._turnHadOutput) {
        await new Promise<void>(r => setTimeout(r, Math.min(stepMs, graceMs - waited)));
        waited += stepMs;
      }
    }
    this._flushNarration(true);
    if (!timedOut) { this._flushOpenTools('interrupted'); } // Bug B (close() already flushed on timeout)
    this._sink = null;
    this._busy = false;
    this._activity = undefined;
    res.emptyOutput = res.clean && !this._turnHadOutput;
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
   * Deliver a mid-run STEER: send an additional session/prompt the agent QUEUES
   * (FIFO) and runs next — without exiting. The prompt is TRACKED in `_inflight`
   * so the in-progress runTurn drains it before finishing (Bug A) — the steered
   * turn's session/update hooks are forwarded like a normal turn and the loop
   * stays WORKING until it completes. Returns true if handed to the live agent.
   */
  steer(text: string): boolean {
    if (!this.isAlive() || !this._sessionId) { return false; }
    const t = text.trim();
    if (!t) { return false; }
    void this._promptRequest(t); // tracked; drained by the active runTurn
    return true;
  }

  /**
   * Like {@link steer}, but returns a promise that resolves when THAT steered
   * turn actually COMPLETES (grok/opencode runs the queued session/prompt to its
   * stopReason) — or null if it can't be delivered (dead/no session). The prompt
   * is tracked in `_inflight` exactly like `steer()`, so an active runTurn drains
   * it (Bug A). Used by the durable-steer queue to ack / de-queue a steer only on
   * completion, so a restart mid-steer re-delivers it (at-least-once).
   */
  steerTracked(text: string): Promise<AcpTurnResult> | null {
    if (!this.isAlive() || !this._sessionId) { return null; }
    const t = text.trim();
    if (!t) { return null; }
    return this._promptRequest(t).then((r) => classifyAcpResult(r));
  }

  /** Send a tracked session/prompt (primary or steer) and register it in
   *  `_inflight` until it resolves. */
  private _promptRequest(text: string): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
    const p = this._request('session/prompt', { sessionId: this._sessionId, prompt: [{ type: 'text', text }] });
    this._inflight.add(p);
    void p.then(() => { this._inflight.delete(p); }, () => { this._inflight.delete(p); });
    return p;
  }

  /** Wait until every in-flight/queued prompt has resolved. */
  private async _drainInflight(): Promise<void> {
    let guard = 0;
    while (this._inflight.size > 0 && guard++ < 10000) {
      try { await Promise.race([...this._inflight]); } catch { /* ignore */ }
    }
  }

  /**
   * Send a QUIET prompt (e.g. `/compact`) and await it WITHOUT emitting the
   * Stop/SessionEnd turn-boundary hooks — used for maintenance commands so they
   * don't register as a task turn. Best-effort.
   */
  async sendQuiet(text: string): Promise<void> {
    if (!this.isAlive() || !this._sessionId) { return; }
    try { await this._request('session/prompt', { sessionId: this._sessionId, prompt: [{ type: 'text', text }] }); }
    catch { /* ignore */ }
  }

  /** Cancel the running turn (process stays alive). */
  cancel(): void {
    if (!this.isAlive() || !this._sessionId) { return; }
    this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this._sessionId } });
    this._flushOpenTools('cancelled'); // Bug B: close any tools open at cancel
  }

  /** Kill the persistent process. Preserves the known session id for a later load. */
  close(): void {
    const c = this.child;
    this.child = null;
    this._ready = null;
    this._sink = null;
    this._busy = false;
    this._activity = undefined;
    this._flushOpenTools('interrupted'); // Bug B: close any tools open at teardown
    for (const [, p] of this.pending) { try { p.resolve({ error: { message: 'closed' } }); } catch { /* ignore */ } }
    this.pending.clear();
    this._inflight.clear();
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
