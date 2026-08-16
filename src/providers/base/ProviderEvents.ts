// ---------------------------------------------------------------------------
// ProviderEvents — emit / list the hook events a provider family produces.
// Concrete families override `emit` (write JSONL, push over WS, …).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { eventTypeFor } from './ProviderNormalizer';
import type { HookEvent } from './types';

export abstract class ProviderEvents {
  abstract readonly provider: string;

  /** Hook names this family is known to emit (PascalCase). */
  abstract listSupported(): string[];

  /** Persist a hook event to `<root>/.autodev/hooks-events.jsonl`. */
  emit(root: string, hookEventName: string, extra: Record<string, unknown> = {}): HookEvent {
    const ev: HookEvent = {
      hook_event_name: hookEventName,
      event_type: eventTypeFor(hookEventName),
      provider: this.provider,
      cwd: root,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this.append(root, ev);
    return ev;
  }

  /** Append an already-built event to the workspace JSONL sink. */
  append(root: string, ev: HookEvent): void {
    try {
      const dir = path.join(root, '.autodev');
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
    } catch { /* non-critical telemetry */ }
  }

  /** Read every event currently in the workspace JSONL (best-effort). */
  readAll(root: string): HookEvent[] {
    const file = path.join(root, '.autodev', 'hooks-events.jsonl');
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as HookEvent);
    } catch { return []; }
  }
}
