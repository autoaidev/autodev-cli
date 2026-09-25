// ---------------------------------------------------------------------------
// grokEvents — pure parser/classifier for grok's OWN session event log.
//
// A grok session (loop OR operate) writes structured telemetry to
//   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/events.jsonl
// one JSON object per line. Observed record types (schema_version 1.0):
//   • turn_started      {turn_number, model_id, …}   — a turn began
//   • loop_started      {loop_index}                 — an agent loop iteration began
//   • phase_changed     {phase}                      — phase transitions; observed
//        phases: waiting_for_model, streaming_reasoning, streaming_text,
//        tool_execution, permission_prompt (all NON-idle = actively working)
//   • first_token       {}                            — model started emitting
//   • tool_started      {tool_name, tool_call_id?}    — a native tool call began
//   • tool_completed    {tool_name, outcome, duration_ms, tool_call_id?}
//        outcome: "success" | "error"
//   • permission_requested / permission_resolved {tool_name, decision?}
//   • turn_ended        {outcome}                     — the turn finished;
//        outcome "completed" = a CLEAN turn end (grok 4.5 AND 4.7).
//
// These functions are intentionally PURE (no I/O): the operate bridge and the
// grok loop turn-detector both feed lines/objects in and share the exact same
// classification, so the mapping is unit-testable without a socket / tmux pane.
// ---------------------------------------------------------------------------

export interface GrokEvent {
  type: string;
  phase?: string;
  tool_name?: string;
  tool_call_id?: string;
  outcome?: string;
  turn_number?: number;
  model_id?: string;
  [k: string]: unknown;
}

/** Parse one events.jsonl line into a GrokEvent, or null for blank/non-JSON. */
export function parseGrokEventLine(line: string): GrokEvent | null {
  const s = (line || '').trim();
  if (!s) { return null; }
  try {
    const o = JSON.parse(s) as GrokEvent;
    if (o && typeof o === 'object' && typeof o.type === 'string') { return o; }
  } catch { /* not JSON */ }
  return null;
}

// grok phases that mean the turn is NOT actively working (idle / waiting for the
// user / done). None are observed in real dumps today — every real phase
// (streaming_*, tool_execution, waiting_for_model, permission_prompt) is active —
// but this list makes a future "idle"-style phase decay the badge instead of
// pinning it 'working'. `waiting_for_model` is explicitly ACTIVE (grok is mid-turn
// awaiting the model), so it is NOT here.
export const GROK_IDLE_PHASES = new Set<string>([
  'idle', 'done', 'complete', 'completed', 'finished', 'ready', 'waiting_for_input', 'awaiting_input',
]);

export type GrokActivity = 'working' | 'end' | null;

/**
 * Classify a grok event into a status signal for the operate status controller:
 *   'working' — the session is actively doing work (keep/refresh the 'working'
 *               badge + re-arm the inactivity→idle timer)
 *   'end'     — the turn/loop finished (flip to idle NOW, don't wait 120s)
 *   null      — no status meaning (ignore for status)
 * The existing 120s inactivity timer still decays a stuck 'working' to idle.
 */
export function classifyGrokActivity(ev: GrokEvent | null): GrokActivity {
  if (!ev) { return null; }
  switch (ev.type) {
    case 'turn_started':
    case 'loop_started':
    case 'first_token':
    case 'tool_started':
    case 'tool_completed':          // a tool finished — still mid-turn activity
    case 'permission_requested':
    case 'permission_resolved':
      return 'working';
    case 'phase_changed':
      return ev.phase && GROK_IDLE_PHASES.has(ev.phase) ? 'end' : 'working';
    case 'turn_ended':
    case 'loop_ended':
      return 'end';
    default:
      return null;
  }
}

/** A hook event synthesized from a grok native-tool event, in the schema the
 *  pixel-office feed already renders (PreToolUse / PostToolUse[Failure]). */
export interface GrokToolHook {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  tool_name: string;
  tool_use_id?: string;
  outcome?: string;
}

/**
 * Map a grok event to a tool hook the office renders, or null when the event is
 * not a tool boundary (status-only). `tool_started` → PreToolUse; `tool_completed`
 * → PostToolUse, or PostToolUseFailure when outcome === "error". Carries tool_name
 * (+ tool_use_id when grok supplied one, so Pre/Post pair into one step card).
 */
export function grokEventToHook(ev: GrokEvent | null): GrokToolHook | null {
  if (!ev) { return null; }
  const name = (ev.tool_name || '').trim();
  if (!name) { return null; }
  if (ev.type === 'tool_started') {
    return { hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: ev.tool_call_id };
  }
  if (ev.type === 'tool_completed') {
    const failed = String(ev.outcome || '').toLowerCase() === 'error';
    return {
      hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
      tool_name: name,
      tool_use_id: ev.tool_call_id,
      outcome: ev.outcome,
    };
  }
  return null;
}

// Office-operator MCP tool verbs (+ the bridge-synthesized tools). The office
// logs its OWN MCP tools server-side (OfficeMcpController → provider
// 'mcp-operator'), so re-forwarding a grok tool event for them would double-render
// the same call in the Events feed. grok's NATIVE tools (read_file/edit/bash/…) are
// the high-value signal and are NOT in this set. Any `mcp__`-prefixed name is also
// treated as an office/MCP tool (the standard MCP tool prefix).
const OFFICE_TOOL_NAMES = new Set<string>([
  'whoami', 'get_tasks', 'start_task', 'complete_task', 'update_task', 'create_task',
  'check_messages', 'send_message', 'set_status', 'get_events', 'get_office', 'get_agents',
  'create_choice_request', 'get_choice_answer', 'wait_for_events', 'ask_user',
  'graph_add_node', 'graph_add_edge', 'graph_query', 'graph_map', 'graph_search',
  'graph_neighbors', 'graph_toc', 'graph_rollup', 'graph_pin', 'graph_supersede', 'graph_stats',
]);

/** True when a tool name is an office/MCP tool (logged server-side) rather than a
 *  grok native tool — such events must be skipped to avoid double-forwarding. */
export function isOfficeMcpToolName(name: string | undefined | null): boolean {
  const n = (name || '').trim();
  if (!n) { return false; }
  if (n.startsWith('mcp__')) { return true; }
  return OFFICE_TOOL_NAMES.has(n);
}

// grok `turn_ended` outcomes that mean the turn finished CLEANLY (no failure).
const CLEAN_TURN_OUTCOMES = new Set<string>(['completed', 'complete', 'success', 'succeeded', 'done', 'ok']);
// Outcomes that mean the turn ended in a genuine failure/abort.
const ERROR_TURN_OUTCOMES = new Set<string>(['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted', 'interrupted', 'timeout', 'timed_out']);

/** Is a grok `turn_ended` outcome a clean completion? Unknown/empty → false. */
export function isCleanTurnOutcome(outcome: string | undefined | null): boolean {
  return CLEAN_TURN_OUTCOMES.has(String(outcome || '').toLowerCase());
}

/**
 * True if ANY of the given event lines (or objects) is a `first_token` event —
 * grok's signal that the model has actually STARTED generating this turn. Used by
 * the headless grok-tui resume hang-probe: grok 1.0.41's headless `--resume` can
 * LOAD a session (it writes turn_started/phase_changed while alive) but never
 * answer, so the presence of `first_token` — not merely being alive — is the proof
 * the resumed prompt is being processed. Pure (no I/O), so the probe is testable.
 */
export function scanGrokFirstToken(lines: Array<string | GrokEvent>): boolean {
  for (const raw of lines) {
    const ev = typeof raw === 'string' ? parseGrokEventLine(raw) : raw;
    if (ev && ev.type === 'first_token') { return true; }
  }
  return false;
}

export type GrokTurnEnd = 'clean' | 'error' | null;

/**
 * Scan grok event lines (or objects) for the LAST `turn_ended` and classify it:
 *   'clean' — outcome is a completed/success value (the turn finished normally)
 *   'error' — outcome is a failure/abort value
 *   null    — no turn_ended present (turn still running / not seen this batch)
 * Used by the grok loop turn-detector as CORROBORATION: a clean turn_ended is a
 * positive done-signal, so a finished grok 4.7 turn (which may not print the
 * grok-4.5 "Worked for N.Ns." pane marker) is recognized as a clean finish and
 * NEVER misread as a StopFailure/watchdog hard-fail.
 */
export function scanGrokTurnEnd(lines: Array<string | GrokEvent>): GrokTurnEnd {
  let result: GrokTurnEnd = null;
  for (const raw of lines) {
    const ev = typeof raw === 'string' ? parseGrokEventLine(raw) : raw;
    if (!ev || ev.type !== 'turn_ended') { continue; }
    const oc = String(ev.outcome || '').toLowerCase();
    if (isCleanTurnOutcome(oc)) { result = 'clean'; }
    else if (ERROR_TURN_OUTCOMES.has(oc)) { result = 'error'; }
    else { result = 'error'; }   // an unknown non-clean outcome is treated as a failure signal
  }
  return result;
}

/**
 * Extract assistant prose from ONE grok chat_history.jsonl line, or null when the
 * line is not assistant text (user/system/reasoning/tool_result/tool_calls-only).
 * grok `content` is a plain string or an array of {type:'text',text} blocks.
 */
export function grokAssistantText(line: string): string | null {
  const s = (line || '').trim();
  if (!s) { return null; }
  let o: { type?: string; role?: string; content?: unknown };
  try { o = JSON.parse(s); } catch { return null; }
  const kind = o.type || o.role;
  if (kind !== 'assistant') { return null; }
  const c = o.content;
  let text = '';
  if (typeof c === 'string') { text = c; }
  else if (Array.isArray(c)) {
    text = (c as Array<Record<string, unknown>>)
      .map(b => (b && b['type'] === 'text' ? String(b['text'] ?? '') : ''))
      .filter(Boolean).join('\n');
  }
  text = text.trim();
  return text || null;
}

/** One office hook the grok-tui LOOP forwards for a turn, in the schema
 *  `.autodev/hooks-events.jsonl` (and the WS poller that ships it) consumes. */
export interface GrokLoopHook {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Notification';
  tool_name?: string;
  tool_use_id?: string;
  outcome?: string;
  message?: string;
}

/**
 * PURE mapping used by the grok-tui LOOP forwarder (src/providers/grok/tui.ts).
 * Given freshly-tailed `events.jsonl` lines (grok's NATIVE tool boundaries) and
 * `chat_history.jsonl` lines (assistant narration) — already byte-offset so no
 * backlog/replay — plus the loop's per-root dedupe Set of already-emitted tool
 * ids, return the office hook events to append:
 *   • tool_started  → PreToolUse    (emitted once per tool_call_id via `emittedIds`)
 *   • tool_completed→ PostToolUse / PostToolUseFailure (on outcome==="error")
 *   • assistant text→ Notification  (narration bubble)
 * grok's OWN native tools only: any `mcp__*` / office-operator tool is SKIPPED
 * (the office logs those server-side, so re-forwarding double-renders them).
 * No I/O, so the loop's mapping is unit-testable without a grok process.
 */
export function grokLoopForwardHooks(
  eventLines: string[],
  chatLines: string[],
  emittedIds: Set<string>,
): GrokLoopHook[] {
  const out: GrokLoopHook[] = [];
  for (const line of eventLines) {
    const hook = grokEventToHook(parseGrokEventLine(line));
    if (!hook) { continue; }
    if (isOfficeMcpToolName(hook.tool_name)) { continue; } // office logs MCP tools server-side
    if (hook.hook_event_name === 'PreToolUse') {
      const id = hook.tool_use_id;
      // Dedupe by tool_call id so a re-observed line (or a co-emitter) can't
      // double-render the SAME call. Ids are unique per call, so a seen id is a
      // re-scan, not a real second call.
      if (id) {
        if (emittedIds.has(id)) { continue; }
        emittedIds.add(id);
      }
      out.push({ hook_event_name: 'PreToolUse', tool_name: hook.tool_name, tool_use_id: id });
    } else {
      out.push({
        hook_event_name: hook.hook_event_name,
        tool_name: hook.tool_name,
        tool_use_id: hook.tool_use_id,
        outcome: hook.outcome,
      });
    }
  }
  for (const line of chatLines) {
    const text = grokAssistantText(line);
    if (text) { out.push({ hook_event_name: 'Notification', message: text }); }
  }
  return out;
}
