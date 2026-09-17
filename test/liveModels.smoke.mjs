// Offline smoke for the live model catalog seam (grok-first).
//
// Proves:
//   (a) a successful live /v1/models fetch maps grok ids into catalog entries —
//       new ids derive a friendly label + use the reported context_length, and
//       an id matching a static entry KEEPS the static label/contextLimit;
//   (b) EVERY failure mode (no token, non-200, network throw, empty/bad body)
//       falls back to the static list so the picker never goes empty;
//   (c) successful results are cached per-family for the TTL (no refetch), and a
//       fallback never poisons the cache;
//   (d) the grok token reader resolves the `key` from a ~/.grok/auth.json shape.
//
// Fully offline — the HTTP call is a mock; the network is never hit.
// Run: node test/liveModels.smoke.mjs (after build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchLiveModels,
  mapLiveEntries,
  deriveModelLabel,
  isChatModelId,
  filterChatModels,
  __clearLiveModelCache,
} from '../out/providers/base/liveModels.js';
import { GrokProviderModels } from '../out/providers/grok/ProviderModels.js';
import { readGrokToken } from '../out/providers/grok/token.js';

let pass = 0;
const CASES = [];
const ok = (name, fn) => { CASES.push([name, fn]); };

const STATIC = [
  { id: 'grok-4', label: 'Grok 4', contextLimit: 256_000 },
  { id: 'grok-code', label: 'Grok Code', contextLimit: 256_000 },
  { id: 'grok-3', label: 'Grok 3', contextLimit: 131_072 },
];

// Mock an OpenAI-compatible /v1/models response.
const mockFetch = (data) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ object: 'list', data }),
});

// ── (a) live ids map into catalog entries ────────────────────────────────────
ok('live fetch maps grok ids into { id, label, contextLimit } catalog entries', async () => {
  const models = await fetchLiveModels({
    family: 'grok',
    staticModels: STATIC,
    url: 'https://api.x.ai/v1/models',
    token: 'tok',
    defaultContextLimit: 256_000,
    fetchImpl: mockFetch([
      { id: 'grok-4.6', context_length: 500_000 },
      { id: 'grok-4', context_length: 999 }, // matches static → keep static values
      { id: 'grok-4.20-0309-non-reasoning' },  // no context reported → default
    ]),
  });
  assert.deepEqual(models.map((m) => m.id), ['grok-4.6', 'grok-4', 'grok-4.20-0309-non-reasoning'],
    'every returned id becomes an entry, in order');

  const g46 = models.find((m) => m.id === 'grok-4.6');
  assert.equal(g46.label, 'Grok 4.6', 'friendly label derived from the id');
  assert.equal(g46.contextLimit, 500_000, 'contextLimit from the reported context_length');

  const g4 = models.find((m) => m.id === 'grok-4');
  assert.equal(g4.label, 'Grok 4', 'matched static id KEEPS the static label');
  assert.equal(g4.contextLimit, 256_000, 'matched static id KEEPS the static contextLimit (ignores API value)');

  const g420 = models.find((m) => m.id === 'grok-4.20-0309-non-reasoning');
  assert.equal(g420.contextLimit, 256_000, 'no reported context → defaultContextLimit');
  assert.equal(g420.label, 'Grok 4.20 0309 Non Reasoning', 'multi-part id derives a spaced label');
});

// Each entry has exactly the three catalog fields — shape must stay stable.
ok('mapped entries carry only { id, label, contextLimit }', () => {
  const [m] = mapLiveEntries([{ id: 'grok-4.6', context_length: 500_000 }], STATIC, 256_000);
  assert.deepEqual(Object.keys(m).sort(), ['contextLimit', 'id', 'label']);
});

ok('mapLiveEntries de-dups repeated ids and skips blanks', () => {
  const out = mapLiveEntries(
    [{ id: 'grok-4.6' }, { id: 'GROK-4.6' }, { id: '' }, { id: '  ' }, 'grok-4.6'],
    STATIC, 256_000,
  );
  assert.equal(out.length, 1, 'case-insensitive de-dup, blanks dropped');
});

ok('deriveModelLabel title-cases hyphen/underscore/slash parts', () => {
  assert.equal(deriveModelLabel('grok-4.6'), 'Grok 4.6');
  assert.equal(deriveModelLabel('grok-code'), 'Grok Code');
  assert.equal(deriveModelLabel('sxs-kimi-k2-5'), 'Sxs Kimi K2 5');
});

// ── (a2) chat-only filter: media / audio / embedding models are excluded ─────
ok('live fetch DROPS grok-imagine image/video (+ audio/embed) media models', async () => {
  // Mirrors the REAL xAI /v1/models payload: 10 chat + 5 grok-imagine media.
  const models = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: mockFetch([
      { id: 'grok-4.6', context_length: 500_000 },
      { id: 'grok-4.20-multi-agent-0309', context_length: 1_000_000 },
      { id: 'grok-build-0.1', context_length: 256_000 },
      { id: 'grok-imagine-image', context_length: 16_000 },
      { id: 'grok-imagine-image-2.0', context_length: 64_000 },
      { id: 'grok-imagine-image-quality', context_length: 16_000 },
      { id: 'grok-imagine-video' },
      { id: 'grok-imagine-video-1.5' },
      { id: 'grok-tts-1' },
      { id: 'whisper-large' },
      { id: 'text-embedding-3' },
    ]),
  });
  const ids = models.map((m) => m.id);
  assert.deepEqual(ids, ['grok-4.6', 'grok-4.20-multi-agent-0309', 'grok-build-0.1'],
    'only chat/completion models survive; all media/audio/embedding ids dropped');
  for (const bad of ['grok-imagine-image', 'grok-imagine-video', 'grok-tts-1', 'whisper-large', 'text-embedding-3']) {
    assert.ok(!ids.includes(bad), `${bad} must be excluded`);
  }
});

ok('isChatModelId keeps chat/vision ids, rejects media/audio/embedding', () => {
  for (const keep of ['grok-4.6', 'grok-code', 'grok-build-0.1', 'grok-4.20-0309-reasoning',
                      'grok-vision', 'sxs-kimi-k2-5', 'claude-opus-4-8', 'gpt-4o']) {
    assert.equal(isChatModelId(keep), true, `${keep} is a chat model`);
  }
  for (const drop of ['grok-imagine-image', 'grok-imagine-video-1.5', 'grok-imagine-image-quality',
                      'grok-tts-1', 'tts-1', 'whisper-large', 'text-embedding-3', 'embed-english']) {
    assert.equal(isChatModelId(drop), false, `${drop} is NOT a chat model`);
  }
});

ok('modality field WINS over the name heuristic when present', () => {
  // An id that looks like media but the API marks text-output → kept.
  const kept = mapLiveEntries(
    [{ id: 'weird-image-namer', output_modalities: ['text'] }], STATIC, 256_000);
  assert.deepEqual(kept.map((m) => m.id), ['weird-image-namer'], 'text output_modalities keeps it');
  // An innocuously named id the API marks image-output → dropped.
  const dropped = mapLiveEntries(
    [{ id: 'grok-4.6', output_modalities: ['image'] }], STATIC, 256_000);
  assert.deepEqual(dropped, [], 'image-only output_modalities drops it despite a chat-looking id');
});

ok('filterChatModels drops media from a plain catalog list', () => {
  const out = filterChatModels([
    { id: 'grok-4.6', label: 'Grok 4.6', contextLimit: 500_000 },
    { id: 'grok-imagine-image', label: 'x', contextLimit: 16_000 },
  ]);
  assert.deepEqual(out.map((m) => m.id), ['grok-4.6']);
});

// ── (b) fallback to static on every failure mode ─────────────────────────────
ok('no token → static (never touches the network)', async () => {
  let called = false;
  const models = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: null, defaultContextLimit: 256_000,
    fetchImpl: async () => { called = true; throw new Error('should not run'); },
  });
  assert.equal(called, false, 'fetch not attempted without a token');
  assert.deepEqual(models, STATIC);
});

ok('non-200 → static', async () => {
  const models = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.deepEqual(models, STATIC);
});

ok('network throw (e.g. abort/timeout) → static', async () => {
  const models = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.deepEqual(models, STATIC);
});

ok('empty / malformed body → static', async () => {
  const empty = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: mockFetch([]),
  });
  assert.deepEqual(empty, STATIC, 'empty data[] falls back');
  const bad = await fetchLiveModels({
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'not json' }),
  });
  assert.deepEqual(bad, STATIC, 'non-object body falls back');
});

// ── (c) caching ──────────────────────────────────────────────────────────────
ok('successful live result is cached for the TTL (no refetch)', async () => {
  let calls = 0;
  const clock = { t: 1000 };
  const opts = {
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    ttlMs: 60_000, now: () => clock.t,
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'grok-4.6' }] }) }; },
  };
  const a = await fetchLiveModels(opts);
  clock.t += 30_000; // within TTL
  const b = await fetchLiveModels(opts);
  assert.equal(calls, 1, 'second call within TTL served from cache');
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
  clock.t += 40_000; // now past the 60s TTL
  await fetchLiveModels(opts);
  assert.equal(calls, 2, 'refetches after the TTL expires');
});

ok('a fallback does NOT poison the cache', async () => {
  let mode = 'fail';
  const opts = {
    family: 'grok', staticModels: STATIC, url: 'x', token: 'tok', defaultContextLimit: 256_000,
    fetchImpl: async () => mode === 'fail'
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ data: [{ id: 'grok-4.6' }] }) },
  };
  const first = await fetchLiveModels(opts);
  assert.deepEqual(first, STATIC, 'first call fell back');
  mode = 'ok';
  const second = await fetchLiveModels(opts);
  assert.deepEqual(second.map((m) => m.id), ['grok-4.6'], 'next call fetches fresh (failure was not cached)');
});

// ── GrokProviderModels wiring: no token in a scratch GROK_HOME → static ───────
ok('GrokProviderModels.listLive falls back to its static list with no token', async () => {
  const saved = process.env['GROK_HOME'];
  const savedXai = process.env['XAI_API_KEY'];
  const savedGrok = process.env['GROK_API_KEY'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokhome-'));
  process.env['GROK_HOME'] = dir; // empty — no auth.json
  delete process.env['XAI_API_KEY'];
  delete process.env['GROK_API_KEY'];
  try {
    const gm = new GrokProviderModels();
    assert.equal(readGrokToken(), null, 'no token in a bare GROK_HOME');
    const models = await gm.listLive();
    assert.deepEqual(models, gm.list(), 'listLive returns the static list when no token');
  } finally {
    if (saved === undefined) delete process.env['GROK_HOME']; else process.env['GROK_HOME'] = saved;
    if (savedXai !== undefined) process.env['XAI_API_KEY'] = savedXai;
    if (savedGrok !== undefined) process.env['GROK_API_KEY'] = savedGrok;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (d) token reader resolves the `key` from the auth.json shape ─────────────
ok('readGrokToken picks the freshest entry key from ~/.grok/auth.json', () => {
  const saved = process.env['GROK_HOME'];
  const savedXai = process.env['XAI_API_KEY'];
  const savedGrok = process.env['GROK_API_KEY'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokhome-'));
  delete process.env['XAI_API_KEY'];
  delete process.env['GROK_API_KEY'];
  process.env['GROK_HOME'] = dir;
  try {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::old': { key: 'OLD_FAKE_TOKEN', create_time: '2020-01-01T00:00:00Z' },
      'https://auth.x.ai::new': { key: 'NEW_FAKE_TOKEN', create_time: '2026-01-01T00:00:00Z' },
    }));
    assert.equal(readGrokToken(), 'NEW_FAKE_TOKEN', 'freshest create_time wins');
  } finally {
    if (saved === undefined) delete process.env['GROK_HOME']; else process.env['GROK_HOME'] = saved;
    if (savedXai !== undefined) process.env['XAI_API_KEY'] = savedXai;
    if (savedGrok !== undefined) process.env['GROK_API_KEY'] = savedGrok;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

ok('XAI_API_KEY env overrides the auth.json token', () => {
  const savedXai = process.env['XAI_API_KEY'];
  process.env['XAI_API_KEY'] = 'ENV_FAKE_TOKEN';
  try {
    assert.equal(readGrokToken(), 'ENV_FAKE_TOKEN');
  } finally {
    if (savedXai === undefined) delete process.env['XAI_API_KEY']; else process.env['XAI_API_KEY'] = savedXai;
  }
});

(async () => {
  for (const [name, fn] of CASES) {
    __clearLiveModelCache();
    await fn();
    console.log('  ✓', name);
    pass++;
  }
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('  ✗', e && e.message ? e.message : e); process.exit(1); });
