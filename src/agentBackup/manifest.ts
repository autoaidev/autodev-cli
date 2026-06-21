import * as fs from 'fs';
import * as path from 'path';
import type { Portability } from './sessionProviders';

/** Per-provider record in the manifest. */
export interface ProviderManifestEntry {
  /** Portability classification for this provider family. */
  portability: Portability;
  /** Human-readable explanation of what was/wasn't captured. */
  note: string;
  /** Session IDs discovered for this workspace. */
  discoveredSessionIds: string[];
  /** Currently connected session ID(s) from session-state.json, keyed. */
  connectedSessionIds: Record<string, string | null>;
  /** True if real conversation traces were written into the archive. */
  tracesCaptured: boolean;
}

/** Manifest written into the archive describing what was captured. */
export interface SessionManifest {
  exportedAt: string;
  workspaceRoot: string;
  providers: Record<string, ProviderManifestEntry>;
}

/** Read all string-valued session IDs from `<root>/.autodev/session-state.json`. */
export function readSessionState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.join(root, '.autodev', 'session-state.json');
  try {
    if (!fs.existsSync(p)) { return out; }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) { out[k] = v; }
    }
  } catch { /* ignore malformed file */ }
  return out;
}

/** Parse a manifest from its JSON text, or `undefined` if invalid. */
export function parseManifest(text: string | undefined): SessionManifest | undefined {
  if (!text) { return undefined; }
  try { return JSON.parse(text) as SessionManifest; } catch { return undefined; }
}
