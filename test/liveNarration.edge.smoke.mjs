// Offline EDGE smoke for LiveNarrationStreamer — hardening against the nasty
// stream shapes the happy-path smoke (liveNarration.smoke.mjs) doesn't cover,
// exercised against the REAL streamer + its default .autodev/hooks-events.jsonl
// file sink. Fully deterministic: every scenario ends in an explicit flush() (or
// a synchronous flushChars threshold), never a live timer.
//
// Edge cases asserted:
//   1. UTF-8 multibyte code points SPLIT across chunk boundaries (raw bytes fed
//      as Buffer/Uint8Array) reassemble intact — never mojibake (U+FFFD).
//   2. Rapid tiny deltas still coalesce into few frames, not one-per-token.
//   3. Empty / whitespace-only chunks emit NO Notification at all.
//   4. Very long lines flush via flushChars without dropping/garbling chars.
//   5. dispose() drops a half-decoded multibyte tail (no leak into later reuse).
//   6. Edge telemetry tags (splits=/pending=) appear only when non-zero, so a
//      clean stream's stderr line stays byte-identical to the pre-hardening one.
//
// Run: node test/liveNarration.edge.smoke.mjs (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveNarrationStreamer, appendHookEventLine } from '../out/core/liveNarration.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const REPLACEMENT = '�'; // the mojibake char a naive per-chunk decode would emit

function tmpRoot(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `autodev-narr-edge-${tag}-`)));
}
function readEvents(root) {
  const f = path.join(root, '.autodev', 'hooks-events.jsonl');
  if (!fs.existsSync(f)) { return []; }
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function assertNotificationShape(ev, provider, root) {
  assert.equal(ev.hook_event_name, 'Notification', 'persisted as a Notification hook event');
  assert.equal(ev.event_type, 'notification', 'event_type pixel-office renders as a bubble');
  assert.equal(ev.provider, provider, 'carries the originating provider');
  assert.equal(ev.cwd, root, 'cwd points at the workspace root');
  assert.ok(typeof ev.message === 'string' && ev.message.length > 0, 'frame carries text');
}
/** Capture everything written to process.stderr while fn() runs. */
function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return lines.join('');
}

// A mix of 1-, 2-, 3- and 4-byte UTF-8 code points (surrogate-pair emoji included).
const UNICODE = 'café ünïcodé — 中文字 test 🚀 ✓ naïve résumé 😀 done';

// ── 1a: split byte-by-byte (worst case: EVERY multibyte char is torn) →
//     one clean frame that equals the original text, no U+FFFD anywhere.
ok('UTF-8 split byte-by-byte reassembles intact (no mojibake)', () => {
  const provider = 'opencode-cli';
  const root = tmpRoot('utf8-bytewise');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev));
    const bytes = Buffer.from(UNICODE, 'utf8');
    for (const byte of bytes) { s.push(Buffer.from([byte])); } // feed one raw byte at a time
    s.flush();
    const events = readEvents(root);
    assert.equal(events.length, 1, 'single coalesced frame at the boundary');
    assertNotificationShape(events[0], provider, root);
    assert.ok(!events[0].message.includes(REPLACEMENT), 'no replacement char leaked');
    assert.equal(events[0].message, UNICODE, 'bubble equals the intended unicode text');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 1b: split at flush boundaries — small flushChars forces multiple mid-turn
//     frames while code points are still being torn; NO frame may contain U+FFFD
//     and the concatenation must reproduce the full text.
ok('UTF-8 split across incremental flushes: every frame clean, whole text intact', () => {
  const provider = 'copilot-cli';
  const root = tmpRoot('utf8-incr');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev), {
      flushChars: 8, flushMs: 60_000,
    });
    const bytes = Buffer.from(UNICODE, 'utf8');
    // 3-byte slices deliberately land mid-code-point for the multibyte runs.
    for (let i = 0; i < bytes.length; i += 3) { s.push(bytes.subarray(i, i + 3)); }
    s.flush();
    const events = readEvents(root);
    assert.ok(events.length >= 2, 'streamed as multiple incremental frames');
    for (const ev of events) {
      assertNotificationShape(ev, provider, root);
      assert.ok(!ev.message.includes(REPLACEMENT), 'no frame carries mojibake');
    }
    // Each bubble is trim()'d (normal-path behavior), so whitespace landing on a
    // frame boundary is dropped; compare with whitespace removed — every visible
    // (non-space) code point of the torn stream must survive in order.
    const strip = (s2) => s2.replace(/\s+/g, '');
    assert.equal(strip(events.map((e) => e.message).join('')), strip(UNICODE),
      'frames reproduce the full text (mojibake-free) with no dropped code points');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 2: rapid tiny deltas (one char per push) still coalesce into ONE frame.
ok('rapid tiny deltas coalesce into a single frame', () => {
  const provider = 'grok-cli';
  const root = tmpRoot('tiny');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev));
    const clean = 'Opening a pull request and summarizing the diff for review.';
    for (const ch of clean) { s.push(ch); } // 58 one-char pushes
    s.flush();
    const events = readEvents(root);
    assert.equal(events.length, 1, 'many tiny pushes → one frame, not one-per-token');
    assert.equal(events[0].message, clean, 'exact reconstruction with no dropped chars');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 3: empty / whitespace-only chunks (string AND empty Buffer) emit nothing.
ok('empty and whitespace-only chunks emit no Notification', () => {
  const provider = 'copilot-sdk';
  const root = tmpRoot('empty');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev), { flushChars: 4 });
    s.push('');            // empty string
    s.push('   ');         // spaces
    s.push('\n\t  \r\n');  // mixed whitespace (also exceeds flushChars=4 → forces a flush attempt)
    s.push(Buffer.alloc(0)); // empty buffer
    s.flush();             // trailing whitespace must NOT produce a bubble
    assert.equal(readEvents(root).length, 0, 'no empty/whitespace Notification reaches the sink');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 4a: a very long line fed as many tiny deltas with flushChars <= previewLen
//     streams as several frames whose concatenation is the FULL text — every
//     char preserved, none dropped at flush boundaries.
ok('very long line streams via flushChars with no dropped chars', () => {
  const provider = 'opencode-sdk';
  const root = tmpRoot('long');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev), {
      flushChars: 100, previewLen: 200, flushMs: 60_000,
    });
    const longLine = Array.from({ length: 600 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    for (const ch of longLine) { s.push(ch); }
    s.flush();
    const events = readEvents(root);
    assert.ok(events.length >= 3, 'long line produced several incremental frames');
    for (const ev of events) {
      assert.ok(ev.message.length <= 200, 'each frame respects previewLen');
    }
    assert.equal(events.map((e) => e.message).join(''), longLine, 'concatenation reproduces the whole line');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 4b: a single oversized push crosses flushChars and flushes without crashing;
//     the (preview-capped) frame's leading chars are intact and in order.
ok('single oversized push flushes on flushChars threshold, leading text intact', () => {
  const provider = 'grok-cli';
  const root = tmpRoot('oversize');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev)); // defaults: flushChars 400, previewLen 280
    const giant = 'x'.repeat(5000);
    s.push(giant); // one enormous chunk
    const events = readEvents(root);
    assert.equal(events.length, 1, 'threshold fired exactly one flush');
    const msg = events[0].message;
    assert.equal(msg.length, 280, 'capped at previewLen');
    assert.ok(msg.endsWith('…'), 'preview ellipsis appended');
    assert.equal(msg.slice(0, 279), 'x'.repeat(279), 'leading chars intact and in order');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 5: dispose() drops a half-decoded multibyte tail — a fresh push afterwards
//     must NOT be prefixed with a stray replacement char from the aborted turn.
ok('dispose() drops a half-decoded tail (no mojibake leaks into reuse)', () => {
  const provider = 'copilot-cli';
  const root = tmpRoot('dispose');
  try {
    const s = new LiveNarrationStreamer(provider, root, (ev) => appendHookEventLine(root, ev));
    const rocket = Buffer.from('🚀', 'utf8'); // 4 bytes
    s.push(rocket.subarray(0, 2)); // feed only half the code point
    s.dispose();                   // abort mid-code-point
    assert.equal(readEvents(root).length, 0, 'aborted turn wrote nothing');
    s.push('fresh start');         // reuse the streamer
    s.flush();
    const events = readEvents(root);
    assert.equal(events.length, 1, 'the reused streamer emits the new turn');
    assert.equal(events[0].message, 'fresh start', 'no leftover byte prefixes the new text');
    assert.ok(!events[0].message.includes(REPLACEMENT), 'no replacement char leaked from the dropped tail');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 6: telemetry — edge tags appear only when non-zero. A clean string stream's
//     stderr line must be byte-identical to the pre-hardening format (no splits=/
//     pending=); a byte-split stream surfaces splits=.
ok('telemetry tags are emitted only for the edge path, never for a clean stream', () => {
  const root = tmpRoot('telemetry');
  try {
    const cleanLog = captureStderr(() => {
      const s = new LiveNarrationStreamer('grok-cli', root, () => {});
      s.push('a clean single-frame turn');
      s.flush();
    });
    assert.ok(/^\[live-narration] provider=grok-cli chunks=1 bytes=\d+ stripped=false\n$/.test(cleanLog),
      `clean stream stderr line unchanged, got: ${JSON.stringify(cleanLog)}`);
    assert.ok(!cleanLog.includes('splits=') && !cleanLog.includes('pending='), 'no edge tags on the clean path');

    const splitLog = captureStderr(() => {
      const s = new LiveNarrationStreamer('opencode-cli', root, () => {});
      const bytes = Buffer.from('café 🚀', 'utf8');
      for (const byte of bytes) { s.push(Buffer.from([byte])); }
      s.flush();
    });
    assert.ok(splitLog.includes('splits='), 'byte-split stream reports a splits= counter');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
