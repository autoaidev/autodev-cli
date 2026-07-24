// ---------------------------------------------------------------------------
// Effective-model resolution + friendly display names
// ---------------------------------------------------------------------------
//
// The pixel-office UI shows the model each agent is running (e.g. "Opus 4.8",
// "kimi-k2.7-code", "grok-code"). The producer of that signal is the CLI: it
// knows the provider and the per-provider model override the user configured.
// This module maps the raw configured id (claudeModel/copilotModel/
// opencodeModel/grokModel) to a friendly label that rides in the `agent_online`
// frame's meta as `model`.
//
// Design notes:
//  - When the per-provider model setting is EMPTY, the provider runs its own
//    account default which the CLI does not know statically, so we return
//    `undefined` and let the office gate the field (it may still learn the
//    runtime model from provider hook events server-side).
//  - Unknown ids pass through verbatim (minus a vendor/cloud suffix) — never
//    fabricate a name.

/** Minimal shape this resolver needs from Settings (kept loose for reuse). */
export interface ModelResolvableSettings {
  provider?: string;
  claudeModel?: string;
  copilotModel?: string;
  opencodeModel?: string;
  grokModel?: string;
}

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
 *
 * Handles:
 *  - opencode "vendor/model" ids  → keep the model segment
 *  - ":cloud" / ":free" / "@date" suffixes → stripped
 *  - claude 1M-context "-1m" suffix → stripped
 *  - full/generic claude ids (claude-opus-4-8, claude-sonnet-4.6) → "Opus 4.8"
 *  - bare claude aliases (opus/sonnet/haiku) → Title-cased
 *  - everything else → passed through verbatim
 *
 * Returns undefined for empty/absent input (never fabricates a name).
 */
export function friendlyModelName(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let id = String(raw).trim();
  if (id === '') return undefined;

  // opencode "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5"
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  // Strip a routing/cloud suffix ("kimi-k2.7-code:cloud", "model@2025-01")
  id = id.replace(/[:@].*$/, '').trim();
  if (id === '') return undefined;

  const lower = id.toLowerCase();
  // Claude 1M-context variants share a display name with the base model.
  const base = lower.replace(/-1m$/, '');

  if (FRIENDLY_OVERRIDES[base]) return FRIENDLY_OVERRIDES[base];

  // Generic claude id: claude-<family>-<major>[.<minor>] (dash OR dot separator).
  const m = base.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `${fam} ${ver}`;
  }

  // Bare claude aliases.
  if (base === 'opus' || base === 'sonnet' || base === 'haiku') {
    return base[0].toUpperCase() + base.slice(1);
  }

  // Unknown → pass the (de-suffixed) raw id through.
  return id;
}

/**
 * Resolve the effective, friendly model name for an agent from its provider +
 * per-provider model override. Returns undefined when no override is set (the
 * provider's own account default is in effect and not known statically here).
 */
export function resolveConfiguredModel(s: ModelResolvableSettings): string | undefined {
  const p = String(s.provider ?? '');
  let raw: string | undefined;
  if (p.startsWith('claude'))        raw = s.claudeModel;
  else if (p.startsWith('copilot'))  raw = s.copilotModel;
  else if (p.startsWith('opencode')) raw = s.opencodeModel;
  else if (p.startsWith('grok'))     raw = s.grokModel;
  return friendlyModelName(raw);
}
