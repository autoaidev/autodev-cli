// ---------------------------------------------------------------------------
// ProviderModels — catalog of models a provider family supports, plus the
// friendly-name resolver the office UI shows on agent_online.
// ---------------------------------------------------------------------------

import type { ModelInfo } from './types';

/** Exact raw-id → friendly-name overrides (fast path for the common Claude ids). */
const FRIENDLY_OVERRIDES: Record<string, string> = {
  'claude-opus-4-8':   'Opus 4.8',
  'claude-opus-4-1':   'Opus 4.1',
  'claude-opus-4':     'Opus 4',
  'claude-sonnet-5':   'Sonnet 5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4':   'Sonnet 4',
  'claude-haiku-4-5':  'Haiku 4.5',
  'claude-haiku-4':    'Haiku 4',
};

/**
 * Map a raw provider model id to a friendly display name.
 * Returns undefined for empty/absent input (never fabricates a name).
 */
export function friendlyModelName(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let id = String(raw).trim();
  if (id === '') return undefined;

  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  id = id.replace(/[:@].*$/, '').trim();
  if (id === '') return undefined;

  const lower = id.toLowerCase();
  const base = lower.replace(/-1m$/, '');

  if (FRIENDLY_OVERRIDES[base]) return FRIENDLY_OVERRIDES[base];

  const m = base.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `${fam} ${ver}`;
  }

  if (base === 'opus' || base === 'sonnet' || base === 'haiku') {
    return base[0].toUpperCase() + base.slice(1);
  }

  return id;
}

/** Minimal shape this resolver needs from Settings (kept loose for reuse). */
export interface ModelResolvableSettings {
  provider?: string;
  claudeModel?: string;
  copilotModel?: string;
  opencodeModel?: string;
  grokModel?: string;
  dummyModel?: string;
}

/**
 * Resolve the effective, friendly model name for an agent from its provider +
 * per-provider model override. Returns undefined when no override is set.
 */
export function resolveConfiguredModel(s: ModelResolvableSettings): string | undefined {
  const p = String(s.provider ?? '');
  let raw: string | undefined;
  if (p.startsWith('claude'))        raw = s.claudeModel;
  else if (p.startsWith('copilot'))  raw = s.copilotModel;
  else if (p.startsWith('opencode')) raw = s.opencodeModel;
  else if (p.startsWith('grok'))     raw = s.grokModel;
  else if (p.startsWith('dummy'))    raw = s.dummyModel;
  return friendlyModelName(raw);
}

export abstract class ProviderModels {
  abstract readonly family: string;
  abstract list(): ModelInfo[];

  resolve(id?: string): ModelInfo | undefined {
    if (!id) { return undefined; }
    const lower = id.toLowerCase();
    return this.list().find(m => m.id.toLowerCase() === lower || m.label.toLowerCase() === lower);
  }

  contextLimit(id?: string): number {
    return this.resolve(id)?.contextLimit ?? this.defaultContextLimit();
  }

  defaultContextLimit(): number {
    return this.list()[0]?.contextLimit ?? 128_000;
  }

  friendlyName(id?: string | null): string | undefined {
    return friendlyModelName(id);
  }
}
