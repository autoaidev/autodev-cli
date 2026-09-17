// ---------------------------------------------------------------------------
// liveModels — generic seam for pulling a provider's REAL model list live from
// its OpenAI-compatible `/v1/models` endpoint, mapped into the same ModelInfo
// catalog shape the static lists use.
//
// Design goals (see `autodev models`):
//   • The picker must NEVER go empty. Any failure (no token, offline, non-200,
//     bad JSON, timeout) falls back to the provider's static ProviderModels list.
//   • A ~4s AbortController timeout bounds the live call.
//   • Successful live results are cached per-family for a short TTL so repeated
//     `models --json` invocations in one process don't refetch.
//   • The returned shape is byte-for-byte the same { id, label, contextLimit }.
// ---------------------------------------------------------------------------

import type { ModelInfo } from './types';

/** Minimal fetch shape — avoids depending on DOM/undici types and is injectable in tests. */
type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: unknown },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface CacheEntry { ts: number; models: ModelInfo[] }

const CACHE = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

export interface LiveModelOptions {
  /** Cache key + family label (e.g. 'grok'). */
  family: string;
  /** The static catalog — returned verbatim whenever the live call can't deliver. */
  staticModels: ModelInfo[];
  /** OpenAI-compatible models endpoint, e.g. https://api.x.ai/v1/models */
  url: string;
  /** Bearer / api-key token. When absent, we never hit the network — static is returned. */
  token?: string | null;
  /** Context limit for live ids that neither match a static entry nor report one. */
  defaultContextLimit: number;
  /** Extra request headers (e.g. { 'anthropic-version': '2023-06-01' }). */
  headers?: Record<string, string>;
  /** Auth header style. 'bearer' → Authorization: Bearer; 'x-api-key' → x-api-key. Default bearer. */
  authHeader?: 'bearer' | 'x-api-key';
  timeoutMs?: number;
  ttlMs?: number;
  // ── injectables (tests only) ─────────────────────────────────────────────
  now?: () => number;
  fetchImpl?: FetchLike;
}

// ── chat/completion filter ───────────────────────────────────────────────────
// The picker should only surface TEXT chat/completion models. A provider's
// `/v1/models` can also list media-generation (image/video), audio (tts/whisper)
// and embedding models — those aren't usable as an agent's chat model.
//
// Name heuristic: ids matching these are excluded. Vision-INPUT chat models
// (e.g. grok-vision) do NOT match any token here, so they are kept.
const NON_CHAT_ID_RE = /(imagine|image|video|whisper|embedding|embed)/i;
// `tts` only as a whole token (so it can't swallow an unrelated substring).
const TTS_ID_RE = /(^|[-_/])tts([-_/]|$)/i;

/**
 * Name-only heuristic: is this model id a TEXT chat/completion model?
 * Used for entries (and static lists) that carry no modality field.
 */
export function isChatModelId(id: string): boolean {
  const s = String(id ?? '').trim().toLowerCase();
  if (!s) return false;
  if (NON_CHAT_ID_RE.test(s)) return false;
  if (TTS_ID_RE.test(s)) return false;
  return true;
}

/**
 * Prefer the API's own modality/type field when a `/v1/models` entry carries one.
 * Returns true when the entry is definitively NON-chat (image/video/audio/embedding),
 * false when definitively chat/text, and undefined when the entry says nothing —
 * in which case the caller falls back to the name heuristic.
 */
function nonChatByModality(o: Record<string, unknown>): boolean | undefined {
  const outs = o['output_modalities'] ?? o['output_modality'] ?? o['modalities'];
  const arr = Array.isArray(outs) ? outs : (typeof outs === 'string' ? [outs] : null);
  if (arr && arr.length) {
    const mods = arr.map((x) => String(x).toLowerCase());
    const hasText = mods.includes('text');
    const hasMedia = mods.some((m) => ['image', 'video', 'audio', 'embedding'].includes(m));
    if (hasText) return false;               // emits text → it's a chat/completion model
    if (hasMedia) return true;               // emits only media → not a chat model
  }
  const type = o['type'] ?? o['modality'];
  if (typeof type === 'string') {
    const t = type.toLowerCase();
    if (/(image|video|audio|embed|tts|whisper|speech)/.test(t)) return true;
    if (/(chat|text|completion|language)/.test(t)) return false;
  }
  return undefined;
}

/** Is this live `/v1/models` entry a chat model? Modality field wins; else name heuristic. */
export function isChatEntry(id: string, o?: Record<string, unknown>): boolean {
  if (o) {
    const byModality = nonChatByModality(o);
    if (byModality === true) return false;
    if (byModality === false) return true;
  }
  return isChatModelId(id);
}

/** Drop non-chat (media/audio/embedding) entries from a catalog list. */
export function filterChatModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => isChatModelId(m.id));
}

/** "grok-4.6" → "Grok 4.6"; "grok-4.20-0309-non-reasoning" → "Grok 4.20 0309 Non Reasoning". */
export function deriveModelLabel(id: string): string {
  const cleaned = String(id ?? '').trim();
  if (!cleaned) return cleaned;
  return cleaned
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Map raw `/v1/models` `data[]` entries into catalog entries.
 *   • A returned id that matches a static entry KEEPS that entry's label + contextLimit.
 *   • Otherwise: friendly label derived from the id; contextLimit from the entry's
 *     context_length / context_window when present, else `defaultContextLimit`.
 * Order and de-dup follow the provider's response.
 */
export function mapLiveEntries(
  data: unknown[],
  staticModels: ModelInfo[],
  defaultContextLimit: number,
): ModelInfo[] {
  const byId = new Map(staticModels.map((m) => [m.id.toLowerCase(), m]));
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    let id = '';
    let ctxRaw = 0;
    let obj: Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object') {
      obj = raw as Record<string, unknown>;
      id = String(obj['id'] ?? '').trim();
      ctxRaw = Number(obj['context_length'] ?? obj['context_window'] ?? obj['contextLimit'] ?? 0);
    } else if (typeof raw === 'string') {
      id = raw.trim();
    }
    if (!id) continue;
    // Keep only TEXT chat/completion models — drop image/video/audio/embedding.
    // The API's own modality field wins when present; otherwise the name heuristic.
    if (!isChatEntry(id, obj)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byId.get(key);
    const contextLimit = match
      ? match.contextLimit
      : (Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.round(ctxRaw) : defaultContextLimit);
    const label = match ? match.label : deriveModelLabel(id);
    out.push({ id, label, contextLimit });
  }
  return out;
}

async function doFetch(opts: LiveModelOptions, token: string): Promise<ModelInfo[] | null> {
  const fetchImpl: FetchLike | undefined = opts.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    if ((opts.authHeader ?? 'bearer') === 'x-api-key') headers['x-api-key'] = token;
    else headers['Authorization'] = `Bearer ${token}`;

    const res = await fetchImpl(opts.url, { headers, signal: controller.signal });
    if (!res || !res.ok) return null;
    const json = (await res.json().catch(() => null)) as unknown;
    let data: unknown[] | null = null;
    if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown[] }).data)) {
      data = (json as { data: unknown[] }).data;
    } else if (Array.isArray(json)) {
      data = json;
    }
    if (!data || data.length === 0) return null;
    const mapped = mapLiveEntries(data, opts.staticModels, opts.defaultContextLimit);
    return mapped.length ? mapped : null;
  } catch {
    // Timeout / network / parse — the caller falls back to static.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a provider's live model catalog, with static fallback + short-lived cache.
 * Only SUCCESSFUL live results are cached; a fallback never poisons the cache.
 */
export async function fetchLiveModels(opts: LiveModelOptions): Promise<ModelInfo[]> {
  // The static fallback is filtered the same way as the live list so the picker
  // never surfaces a media/embedding model regardless of which path is taken.
  const staticChat = filterChatModels(opts.staticModels);
  if (!opts.token || !String(opts.token).trim()) return staticChat;

  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = CACHE.get(opts.family);
  if (cached && now() - cached.ts < ttl) return cached.models.slice();

  const live = await doFetch(opts, String(opts.token));
  if (live) {
    CACHE.set(opts.family, { ts: now(), models: live });
    return live.slice();
  }
  return staticChat;
}

/** Test-only: reset the per-process cache between cases. */
export function __clearLiveModelCache(): void {
  CACHE.clear();
}
