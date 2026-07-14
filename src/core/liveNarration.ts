// ---------------------------------------------------------------------------
// liveNarration — turn a provider's streamed assistant text into live
// `Notification` hook events so NON-Claude providers surface real-time progress
// in the pixel-office chat.
//
// Why this exists
// ---------------
// pixel-office's chat feed is fully provider-agnostic: it renders whatever
// `hook_event` frames arrive. Claude streams live because Claude Code fires
// PreToolUse/PostToolUse/AgentMessage hooks DURING a turn (written to
// `.autodev/hooks-events.jsonl`, shipped by the task-loop's WS poller). The
// other providers historically wrote either nothing (copilot-cli, opencode-cli
// — only synthetic SessionStart/SessionEnd boundary hooks) or buffered the
// assistant's text and emitted it once at the turn boundary (opencode-sdk /
// copilot-sdk), so the chat only updated when the turn ended.
//
// grok already solved this by coalescing its streamed assistant text into
// periodic `Notification` events. This module extracts that proven pattern into
// one reusable, unit-testable helper so every non-Claude provider can emit the
// SAME incremental frame type. pixel-office renders `notification` (and
// `agent_message`) events as assistant bubbles (see AgentChatTab NARRATION_EVENTS),
// so the streamed text shows up live, in pieces, exactly like grok.
//
// Claude (claude-cli / claude-tui) is intentionally NOT wired through this — it
// already streams natively and must stay unchanged.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { eventTypeFor } from '../hookEventNormalizer';

/** A minimal live hook event in the unified schema pixel-office consumes. */
export interface LiveHookEvent {
  hook_event_name: string;
  event_type: string;
  provider: string;
  cwd: string;
  message: string;
  title: string;
  tool_name: string;
  timestamp: string;
  [k: string]: unknown;
}

/**
 * Build a `Notification` hook event carrying a chunk of streamed assistant text.
 * event_type is resolved through the shared map (→ 'notification') so downstream
 * consumers never have to re-derive it per provider.
 */
export function buildNotificationEvent(provider: string, root: string, message: string): LiveHookEvent {
  return {
    hook_event_name: 'Notification',
    event_type: eventTypeFor('Notification'),
    provider,
    cwd: root,
    message,
    title: provider,
    tool_name: provider,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Append a live hook event to `<root>/.autodev/hooks-events.jsonl` — the same
 * sink grok and the SDK providers use and the task-loop's WS poller tails. This
 * is the default emit sink for {@link LiveNarrationStreamer}; tests inject their
 * own emit callback instead.
 */
export function appendHookEventLine(root: string, ev: LiveHookEvent): void {
  try {
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* non-critical — never let a telemetry write break a task */ }
}

// Strip ANSI/VT control sequences so raw terminal stdout (copilot-cli /
// opencode-cli) becomes clean text before it is surfaced as a chat bubble.
// Matches CSI sequences (ESC [ ... final byte) and single-char ESC escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\x1B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])', 'g');

/** Remove ANSI escape codes and carriage returns from a chunk of terminal output. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '');
}

export interface LiveNarrationOptions {
  /** Flush as soon as the buffer reaches this many chars (default 400). */
  flushChars?: number;
  /** Otherwise flush this many ms after the last push (default 1200). */
  flushMs?: number;
  /** Cap an emitted message at this length, adding an ellipsis (default 280). */
  previewLen?: number;
}

/**
 * Coalesces a stream of assistant-text chunks and emits periodic `Notification`
 * hook events — frequently enough to feel live, coarsely enough to avoid one
 * event per token. Emits when the buffer grows past `flushChars`, or `flushMs`
 * after the latest chunk, whichever comes first. Call {@link flush} at the turn
 * boundary to push the trailing text, or {@link dispose} to drop it on abort.
 */
export class LiveNarrationStreamer {
  private _buf = '';
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private readonly _flushChars: number;
  private readonly _flushMs: number;
  private readonly _previewLen: number;
  // Lifetime counters for low-noise telemetry: incremented once per push() (NOT
  // per char) so the running totals prove — from stderr logs alone — that a given
  // provider is actually streaming chunks rather than emitting once at turn end.
  private _chunks = 0;
  private _bytes = 0;

  constructor(
    private readonly provider: string,
    private readonly root: string,
    private readonly emit: (ev: LiveHookEvent) => void,
    opts: LiveNarrationOptions = {},
  ) {
    this._flushChars = opts.flushChars ?? 400;
    this._flushMs = opts.flushMs ?? 1200;
    this._previewLen = opts.previewLen ?? 280;
  }

  /** Feed newly-produced assistant text. Emits when the buffer is large enough. */
  push(text: string): void {
    if (!text) { return; }
    this._chunks++;
    this._bytes += Buffer.byteLength(text, 'utf8');
    this._buf += text;
    if (this._buf.length >= this._flushChars) { this.flush(); return; }
    if (!this._timer) { this._timer = setTimeout(() => this.flush(), this._flushMs); }
  }

  /** Emit whatever is buffered now (call at turn end). No-op when empty/whitespace. */
  flush(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const t = this._buf.trim();
    this._buf = '';
    if (!t) { return; }
    const preview = t.length > this._previewLen ? t.slice(0, this._previewLen - 1) + '…' : t;
    this.emit(buildNotificationEvent(this.provider, this.root, preview));
    // One structured stderr line per emit (never per char): running proof that
    // THIS provider streamed. `stripped` = the coalesced text still carried
    // ANSI/CR that stripAnsi would remove (raw-terminal providers), computed
    // without mutating the emitted Notification JSON. Best-effort — telemetry
    // must never break a task.
    try {
      const stripped = stripAnsi(t) !== t;
      process.stderr.write(
        `[live-narration] provider=${this.provider} chunks=${this._chunks} bytes=${this._bytes} stripped=${stripped}\n`,
      );
    } catch { /* non-critical — logging must never throw into the task */ }
  }

  /** Drop buffered text and clear the timer WITHOUT emitting (call on abort/close). */
  dispose(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._buf = '';
  }
}
