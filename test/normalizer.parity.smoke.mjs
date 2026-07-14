// Offline parity smoke — "real-time chat works for ALL providers" guarantee.
//
// Goal: lock in that a hook event from every NON-Claude provider
// (grok-cli / grok-tui, opencode-cli / opencode-sdk, copilot-cli / copilot-sdk)
// normalizes — through src/hookEventNormalizer.ts (out/hookEventNormalizer.js) —
// to the SAME unified event schema/shape as claude-cli for the shared event
// kinds pixel-office renders in the live chat:
//
//   notification | tool_start | tool_end | session_start | session_end
//
// The invariant that keeps the chat provider-agnostic is the canonical
// `event_type`: pixel-office keys every chat row off it. If any provider
// normalized a shared kind to a different event_type — or dropped the
// render-relevant fields (tool_name / tool_input / tool_output.text / message) —
// that provider's messages would fall through to "unknown" and never render.
//
// Two code paths inside normalizeEvent are exercised, matching how each real
// integration feeds it:
//   • CLI-hook path (normalizeCliHook): claude-cli, copilot-cli, grok-cli,
//     grok-tui, opencode-cli all pass an ALREADY-FORMATTED hook (hook_event_name
//     present). Feeding the four non-Claude providers the SAME raw as claude and
//     getting a byte-identical result (modulo provider + timestamp) is the
//     strongest possible parity statement.
//   • SDK path (normalizeCopilotSdk / normalizeOpencodeSDK): copilot-sdk and
//     opencode-sdk emit provider-NATIVE events; those must map to claude's
//     event_type and carry the same render fields for tool_start/tool_end/
//     session_end.
//
// The SDK providers' notification frames are produced OUTSIDE normalizeEvent, by
// liveNarration's buildNotificationEvent — so notification parity across all 8
// providers is asserted through that helper too.
//
// Fully offline / deterministic (no server, no timers, no fs writes).
// Run: node test/normalizer.parity.smoke.mjs  (after npm run build).
import assert from 'node:assert';
import { normalizeEvent, eventTypeFor } from '../out/hookEventNormalizer.js';
import { buildNotificationEvent } from '../out/core/liveNarration.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const clone = (o) => JSON.parse(JSON.stringify(o));

// Providers by the normalizeEvent code path they take.
const CLI_HOOK_PROVIDERS = ['copilot-cli', 'grok-cli', 'grok-tui', 'opencode-cli'];
const SDK_PROVIDERS      = ['copilot-sdk', 'opencode-sdk'];
const ALL_PROVIDERS = [
  'claude-cli', 'claude-tui', ...CLI_HOOK_PROVIDERS, ...SDK_PROVIDERS,
];

// Canonical event_type each shared kind MUST resolve to (claude is the baseline).
const EXPECTED_TYPE = {
  notification:  'notification',
  tool_start:    'tool_start',
  tool_end:      'tool_end',
  session_start: 'session_start',
  session_end:   'session_end',
};

// The render-relevant fields pixel-office needs for each kind, reduced to a
// TYPE descriptor so parity is about shape (not the differing values/ids).
// null and "absent" collapse to 'empty' so an optional key a provider omits
// doesn't read as a mismatch against one that emits it as null.
const normType = (v) => (v === undefined || v === null)
  ? 'empty' : (Array.isArray(v) ? 'array' : typeof v);

function shapeFields(ev, kind) {
  switch (kind) {
    case 'notification':  return { message: normType(ev.message) };
    case 'tool_start':    return { tool_name: normType(ev.tool_name), tool_input: normType(ev.tool_input) };
    case 'tool_end':      return {
      tool_name: normType(ev.tool_name),
      tool_output_text: (ev.tool_output && typeof ev.tool_output.text === 'string') ? 'string' : 'empty',
    };
    case 'session_start': return {};
    case 'session_end':   return {};
    default:              return {};
  }
}

/** Universal invariants every normalized event must satisfy, regardless of kind. */
function assertUniversal(ev, provider, kind) {
  assert.ok(ev, `${provider}/${kind}: normalizeEvent returned an event`);
  assert.equal(ev.provider, provider, `${provider}/${kind}: carries its own provider id`);
  assert.equal(ev.event_type, EXPECTED_TYPE[kind], `${provider}/${kind}: canonical event_type`);
  assert.ok(typeof ev.hook_event_name === 'string' && ev.hook_event_name.length > 0,
    `${provider}/${kind}: has a hook_event_name`);
  // The name must itself map to the same canonical type (no divergent aliases).
  assert.equal(eventTypeFor(ev.hook_event_name), EXPECTED_TYPE[kind],
    `${provider}/${kind}: hook_event_name maps to the same canonical event_type`);
  assert.ok(ISO_RE.test(ev.timestamp), `${provider}/${kind}: ISO-8601 timestamp`);
}

// ── Reference: claude-cli, the baseline every provider must match ────────────
// CLI-hook raws (already-formatted hooks, exactly what claude's hook scripts
// write). No `provider` key: normalizeEvent fills it from the provider arg, so
// the ONLY difference between providers on this path is provider + timestamp.
const CLI_RAW = {
  notification:  { hook_event_name: 'Notification', message: 'Reading config and planning the refactor' },
  tool_start:    { hook_event_name: 'PreToolUse',  tool_name: 'Bash', tool_input: { command: 'ls -la' }, session_id: 'sess-1' },
  tool_end:      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_output: { text: 'file1\nfile2' }, success: true, session_id: 'sess-1' },
  session_start: { hook_event_name: 'SessionStart', session_id: 'sess-1', message: 'session started' },
  session_end:   { hook_event_name: 'Stop', session_id: 'sess-1', message: 'done' },
};
const KINDS = Object.keys(CLI_RAW);

// Build the claude-cli baseline once: full event (for byte-identical CLI parity)
// and the reduced render-shape (for cross-path SDK parity).
const claudeEvent = {};
const claudeShape = {};
for (const kind of KINDS) {
  const ev = normalizeEvent('claude-cli', clone(CLI_RAW[kind]));
  assertUniversal(ev, 'claude-cli', kind);
  claudeEvent[kind] = ev;
  claudeShape[kind] = shapeFields(ev, kind);
}
ok('claude-cli baseline normalizes all 5 shared kinds to their canonical event_type', () => {
  for (const kind of KINDS) { assert.equal(claudeEvent[kind].event_type, EXPECTED_TYPE[kind]); }
});

// Strip the two fields that are ALLOWED to differ, so the rest can be compared
// byte-for-byte against claude on the shared CLI-hook path.
const stripVariable = (ev) => { const c = { ...ev }; delete c.provider; delete c.timestamp; return c; };

// ── Group 1: CLI-hook providers are byte-identical to claude-cli ─────────────
// Same raw hook in → same normalized event out, differing ONLY in provider +
// timestamp. This is the tightest parity guarantee: these providers share
// claude's exact code path, so nothing about the schema can drift per provider.
for (const provider of CLI_HOOK_PROVIDERS) {
  ok(`${provider}: every shared kind normalizes byte-identically to claude-cli (CLI-hook path)`, () => {
    for (const kind of KINDS) {
      const ev = normalizeEvent(provider, clone(CLI_RAW[kind]));
      assertUniversal(ev, provider, kind);
      assert.deepEqual(stripVariable(ev), stripVariable(claudeEvent[kind]),
        `${provider}/${kind}: identical to claude modulo provider+timestamp`);
    }
  });
}

// ── Group 2: SDK providers map NATIVE events to claude's shape ───────────────
// copilot-sdk / opencode-sdk speak their own event vocabulary; the normalizer
// must translate the three kinds they emit (tool_start/tool_end/session_end)
// into claude's canonical event_type AND carry the same render fields.
const SDK_RAW = {
  'copilot-sdk': {
    tool_start:  { type: 'tool.execution_start',    data: { toolName: 'Bash', toolCallId: 'sess-1', arguments: { command: 'ls -la' } } },
    tool_end:    { type: 'tool.execution_complete', data: { toolName: 'Bash', toolCallId: 'sess-1', success: true, result: { content: 'file1\nfile2' } } },
    session_end: { type: 'session.task_complete',   data: { summary: 'done' } },
  },
  'opencode-sdk': {
    tool_start:  { payload: { type: 'tool.execute.before', properties: { toolID: 'Bash', args: { command: 'ls -la' }, sessionID: 'sess-1' } } },
    tool_end:    { payload: { type: 'tool.execute.after',  properties: { toolID: 'Bash', args: { command: 'ls -la' }, output: 'file1\nfile2', sessionID: 'sess-1' } } },
    session_end: { payload: { type: 'session.idle',        properties: { sessionID: 'sess-1' } } },
  },
};
for (const provider of SDK_PROVIDERS) {
  ok(`${provider}: native tool_start/tool_end/session_end match claude's event_type + render shape`, () => {
    for (const kind of ['tool_start', 'tool_end', 'session_end']) {
      const ev = normalizeEvent(provider, clone(SDK_RAW[provider][kind]));
      assertUniversal(ev, provider, kind);
      assert.deepEqual(shapeFields(ev, kind), claudeShape[kind],
        `${provider}/${kind}: render fields match claude's shape`);
    }
  });
}

// ── Group 3: notification parity across ALL 8 providers ──────────────────────
// SDK providers' live chat text is emitted via liveNarration.buildNotificationEvent
// (not normalizeEvent). Assert that helper yields claude's exact notification
// shape for every provider — so a streamed bubble is provider-agnostic too.
ok('buildNotificationEvent yields claude-identical notification shape for all 8 providers', () => {
  const ref = buildNotificationEvent('claude-cli', '/work/root', 'hello world');
  assert.equal(ref.hook_event_name, 'Notification');
  assert.equal(ref.event_type, 'notification');
  for (const provider of ALL_PROVIDERS) {
    const ev = buildNotificationEvent(provider, '/work/root', 'hello world');
    // Canonical, render-relevant fields are byte-identical to claude…
    assert.equal(ev.hook_event_name, ref.hook_event_name, `${provider}: hook_event_name`);
    assert.equal(ev.event_type, ref.event_type, `${provider}: event_type notification`);
    assert.equal(ev.cwd, ref.cwd, `${provider}: cwd`);
    assert.equal(ev.message, ref.message, `${provider}: message survives`);
    // …and the provider id is preserved (grok/opencode/copilot are NOT relabelled).
    assert.equal(ev.provider, provider, `${provider}: provider preserved`);
    assert.equal(ev.tool_name, provider, `${provider}: tool_name tag`);
    assert.equal(ev.title, provider, `${provider}: title tag`);
  }
});

// ── Group 4: session_start parity across the CLI-hook providers ──────────────
// (SDK session boundaries arrive as pre-formatted hooks and take the CLI-hook
// path on the wire; here we lock the normalizeEvent contract for that kind.)
ok('session_start normalizes to session_start for claude-cli + all CLI-hook providers', () => {
  for (const provider of ['claude-cli', ...CLI_HOOK_PROVIDERS]) {
    const ev = normalizeEvent(provider, clone(CLI_RAW.session_start));
    assertUniversal(ev, provider, 'session_start');
  }
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
