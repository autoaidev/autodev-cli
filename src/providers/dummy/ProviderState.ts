import { ProviderState } from '../base/ProviderState';

const _busy = new Set<string>();
const _activity = new Map<string, number>();

export class DummyProviderState extends ProviderState {
  readonly family = 'dummy';

  override isBusy(root: string): boolean { return _busy.has(root); }
  override lastActivity(root: string): number { return _activity.get(root) ?? 0; }
  override forceIdle(root: string): void { _busy.delete(root); }

  markBusy(root: string): void { _busy.add(root); _activity.set(root, Date.now()); }
  markIdle(root: string): void { _busy.delete(root); _activity.set(root, Date.now()); }
  override close(root: string): void { _busy.delete(root); }
  override closeAll(): void { _busy.clear(); _activity.clear(); }
}

export function closeAllDummySessions(): void {
  _busy.clear();
  _activity.clear();
}
