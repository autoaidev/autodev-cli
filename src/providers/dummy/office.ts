// ---------------------------------------------------------------------------
// Dummy office bridge — connect the dummy agent to a pixel-office WebSocket
// and ship hook_event frames the same way the task-loop poller does.
// ---------------------------------------------------------------------------

import { OfficeSocket } from '../../officeSocket';
import type { HookEvent } from '../base/types';

export interface DummyOfficeConnect {
  wsUrl: string;
  apiKey: string;
  slug: string;
  log?: (msg: string) => void;
  onMessage?: (msg: Record<string, unknown>) => void;
}

export class DummyOfficeBridge {
  private socket: OfficeSocket | null = null;
  private received: Record<string, unknown>[] = [];
  private sent: Record<string, unknown>[] = [];

  get isConnected(): boolean { return this.socket?.isConnected() ?? false; }
  get receivedFrames(): ReadonlyArray<Record<string, unknown>> { return this.received; }
  get sentFrames(): ReadonlyArray<Record<string, unknown>> { return this.sent; }

  connect(opts: DummyOfficeConnect): OfficeSocket {
    this.disconnect();
    this.received = [];
    this.sent = [];
    const sock = new OfficeSocket(opts.wsUrl, opts.apiKey, opts.slug, {
      log: opts.log,
      meta: { provider: 'dummy', model: 'dummy-fast' },
      onMessage: (msg) => {
        this.received.push(msg);
        opts.onMessage?.(msg);
      },
    });
    this.socket = sock;
    sock.start();
    return sock;
  }

  sendHookEvent(ev: HookEvent): void {
    const frame = { type: 'hook_event', data: ev };
    this.sent.push(frame);
    this.socket?.sendFrame(frame);
  }

  sendHookEvents(events: HookEvent[]): void {
    for (const ev of events) { this.sendHookEvent(ev); }
  }

  /** Wait until the socket reports connected, or reject after `timeoutMs`. */
  waitUntilConnected(timeoutMs = 8_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (this.isConnected) { resolve(); return; }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`dummy office bridge did not connect within ${timeoutMs}ms`));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
