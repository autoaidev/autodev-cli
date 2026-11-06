// ---------------------------------------------------------------------------
// Latest-usage registry — a tiny per-workspace-root store of the most recent
// token/context snapshot a provider surfaced. Decoupled so the `autodev start`
// hook forwarder (taskLoop) can attach `data.usage`/`data.model` to the frames
// it ships WITHOUT importing every provider module (and without the provider
// having to know about the forwarder). This mirrors the ONLY other live usage
// path — mcpOperate.ts, which keeps a `lastUsage` and attaches it to the hook
// frame (the server's HookEventNormalizer reads data.usage → Agent.usage).
//
// All in-process: `autodev start` runs its providers (opencode ACP/SDK, grok
// ACP, copilot SDK) in the SAME process as the forwarder, so one module-level
// Map keyed by workspace root is shared between them. Usage is OPTIONAL: a
// provider that never calls setLatestUsage (e.g. grok yields none) simply leaves
// the root absent and the forwarder omits the field — never a zero-filled frame.
// ---------------------------------------------------------------------------

import type { UsagePayload } from './types';

/** The most recent usage snapshot for a root, plus the model that produced it. */
export interface LatestUsage {
  usage: UsagePayload;
  model?: string;
}

const _latest = new Map<string, LatestUsage>();

/**
 * Record the latest usage snapshot for a workspace root. No-ops on an empty root
 * or a null/undefined usage (so callers can pass an extractor result straight
 * through). `model` is remembered across updates when a later snapshot omits it.
 */
export function setLatestUsage(
  root: string,
  usage: UsagePayload | null | undefined,
  model?: string | null,
): void {
  if (!root || !usage) { return; }
  _latest.set(root, { usage, model: model ?? _latest.get(root)?.model });
}

/** The latest usage snapshot for a root, or undefined when none was surfaced. */
export function getLatestUsage(root: string): LatestUsage | undefined {
  return root ? _latest.get(root) : undefined;
}

/** Drop a root's snapshot (e.g. on session teardown). */
export function clearLatestUsage(root: string): void {
  _latest.delete(root);
}
