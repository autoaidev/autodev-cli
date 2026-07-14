// Offline smoke for Item A — live chat narration for NON-Claude providers.
//
// Goal: prove that representative streamed output from every non-Claude provider,
// pushed through LiveNarrationStreamer with its DEFAULT file sink, lands in
// `<root>/.autodev/hooks-events.jsonl` as `hook_event_name:'Notification'`
// lines whose text is CLEAN and COALESCED:
//   • ANSI/VT escape codes and carriage returns are stripped (copilot-cli /
//     opencode-cli emit raw terminal stdout);
//   • no partial-word garble — the reassembled text reproduces the intended
//     words in order with no escape-sequence residue leaking into the bubble;
//   • many small pushes collapse into few frames (coalescing), not one-per-token.
//
// Four provider shapes are exercised, matching how each real integration feeds
// the streamer:
//   copilot-sdk / opencode-sdk  → delta tokens (already clean, pushed verbatim)
//   copilot-cli  / opencode-cli → line-stream WITH ANSI noise (stripAnsi → push)
//   grok-cli                    → already-clean chunks (grok's proven path)
//
// Fully offline: no live server, no timers relied upon (every scenario ends with
// an explicit flush() at the turn boundary, plus one char-threshold scenario that
// flushes synchronously). Run: node test/liveNarration.smoke.mjs (after build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveNarrationStreamer, appendHookEventLine, stripAnsi } from '../out/core/liveNarration.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const ESC = '';
// Raw ANSI residue that must NEVER survive into a chat bubble (SGR codes minus ESC).
const ANSI_RESIDUE = /\[\d{1,2}(?:;\d{1,2})*m/;

/** Fresh isolated workspace root with a real .autodev sink for each scenario. */
function tmpRoot(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `autodev-narr-${tag}-`)));
}

/** Read back every JSON line the streamer appended to the default file sink. */
function readEvents(root) {
  const f = path.join(root, '.autodev', 'hooks-events.jsonl');
  if (!fs.existsSync(f)) { return []; }
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Assert a persisted line is a well-formed, render-able Notification frame. */
function assertNotificationShape(ev, provider, root) {
  assert.equal(ev.hook_event_name, 'Notification', 'persisted as a Notification hook event');
  assert.equal(ev.event_type, 'notification', 'event_type pixel-office renders as a bubble');
  assert.equal(ev.provider, provider, 'carries the originating provider');
  assert.equal(ev.cwd, root, 'cwd points at the workspace root');
  assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0, 'frame is timestamped');
  assert.ok(typeof ev.message === 'string' && ev.message.length > 0, 'frame carries text');
}

/** Assert a message is clean chat text: no ESC, no CR, no leaked SGR residue. */
function assertCleanText(msg) {
  assert.ok(!msg.includes(ESC), 'no raw ANSI escape survives');
  assert.ok(!msg.includes('\r'), 'no carriage return survives');
  assert.ok(!ANSI_RESIDUE.test(msg), 'no bare SGR residue (e.g. "[0m") leaks into the bubble');
}

// The three provider shapes as they actually reach the streamer.
//  - `raw`   : the exact chunks the provider produces this turn.
//  - `feed`  : how the integration transforms each chunk before push() —
//              CLI providers strip ANSI first; SDK/grok push verbatim.
//  - `clean` : the intended human-readable text the bubble(s) must reconstruct.
const CASES = [
  {
    provider: 'copilot-sdk',
    feed: (c) => c, // SDK deltas are already plain text
    raw: ['Look', 'ing at ', 'the auth ', 'module ', 'and wiring ', 'the callback.'],
  },
  {
    provider: 'opencode-sdk',
    feed: (c) => c,
    raw: ['Refactor', 'ing the ', 'provider ', 'registry ', 'to share ', 'one dispatch path.'],
  },
  {
    provider: 'copilot-cli',
    feed: stripAnsi, // raw terminal stdout → strip before surfacing
    raw: [
      `${ESC}[32m✓${ESC}[0m Building the project\r\n`,
      `${ESC}[1mRunning${ESC}[0m the test suite\r\n`,
      `${ESC}[2K${ESC}[36mAll 42 checks passed${ESC}[0m\r\n`,
    ],
  },
  {
    provider: 'opencode-cli',
    feed: stripAnsi,
    raw: [
      `${ESC}[33mInstalling${ESC}[0m dependencies\r\n`,
      `${ESC}[1m${ESC}[32mLinked${ESC}[0m 12 packages\r\n`,
      `${ESC}[KDone in 3.4s\r\n`,
    ],
  },
  {
    provider: 'grok-cli',
    feed: (c) => c, // grok already emits clean coalesced text
    raw: ['Summariz', 'ing the ', 'diff and ', 'opening a ', 'pull request.'],
  },
];

// ── Scenario 1: default-threshold turn — many pushes coalesce into ONE clean
//    frame per provider, written to the real .autodev/hooks-events.jsonl sink.
for (const { provider, feed, raw } of CASES) {
  ok(`${provider}: coalesced clean Notification persisted to hooks-events.jsonl`, () => {
    const root = tmpRoot(provider);
    try {
      // Wire the streamer to its DEFAULT file sink (what the real poller tails).
      const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev));
      for (const chunk of raw) { s.push(feed(chunk)); }
      s.flush(); // turn boundary

      const events = readEvents(root);
      // Coalescing: 6 small pushes → a single frame, not one-per-token.
      assert.equal(events.length, 1, 'many chunks coalesce into one frame at the boundary');
      const ev = events[0];
      assertNotificationShape(ev, provider, root);
      assertCleanText(ev.message);

      // Exact reconstruction: the bubble equals the intended clean text, so no
      // characters were dropped, duplicated, or garbled at chunk boundaries.
      const expected = stripAnsi(raw.join('')).trim();
      assert.equal(ev.message, expected, 'bubble reproduces the intended text verbatim');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

// ── Scenario 2: mid-turn streaming — a small flushChars forces synchronous
//    char-threshold flushes (no timers), so the file receives MULTIPLE
//    incremental frames DURING the turn. Their concatenation must still be the
//    intact, ANSI-free text: proves live streaming without partial-word garble.
ok('copilot-cli: incremental frames stream live yet reconstruct clean intact text', () => {
  const provider = 'copilot-cli';
  const root = tmpRoot('incr');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev), {
      flushChars: 24, // small → threshold flushes fire as chunks arrive
      flushMs: 60_000, // large → the timer never fires during this synchronous test
    });
    const rawLines = [
      `${ESC}[32mCompiling${ESC}[0m module one\r\n`,
      `${ESC}[32mCompiling${ESC}[0m module two\r\n`,
      `${ESC}[36mBundling${ESC}[0m output artifacts\r\n`,
      `${ESC}[1mLinking${ESC}[0m final binary\r\n`,
    ];
    for (const line of rawLines) { s.push(stripAnsi(line)); }
    s.flush(); // ship the trailing buffer

    const events = readEvents(root);
    // More than one frame → the chat updated mid-turn, not only at the boundary.
    assert.ok(events.length >= 2, 'char-threshold produced multiple incremental frames');
    for (const ev of events) { assertNotificationShape(ev, provider, root); assertCleanText(ev.message); }

    // No word characters lost / injected across flush boundaries (space handling
    // aside): every non-whitespace char of the clean stream is reproduced in order.
    const expected = stripAnsi(rawLines.join('')).trim();
    const strip = (s2) => s2.replace(/\s+/g, '');
    assert.equal(strip(events.map((e) => e.message).join('')), strip(expected),
      'concatenated frames reproduce the clean text with no partial-word garble');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── Scenario 3: abort path — dispose() must leave NO phantom bubble on disk.
ok('dispose() writes nothing to the file sink (no partial bubble on abort)', () => {
  const root = tmpRoot('abort');
  try {
    const s = new LiveNarrationStreamer('opencode-cli', root, (ev) => appendHookEventLine(root, ev), { flushChars: 10_000 });
    s.push(stripAnsi(`${ESC}[31mhalf a line that never finished${ESC}[0m`));
    s.dispose(); // aborted turn
    s.flush();   // even a later flush finds an empty buffer
    assert.equal(readEvents(root).length, 0, 'aborted buffer never reaches the sink');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
