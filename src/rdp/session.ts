/**
 * RdpSession — one tunnel: RdpBridge ↔ WS sender ↔ pixel-office.
 *
 * Mirrors VncSession exactly in structure and message naming conventions:
 *
 *   rdp_ready   — desktop is up; sends { sessionId, name, width, height, colorDepth }
 *   rdp_fbu     — frame-buffer update batch  (same schema as vnc_fbu)
 *   rdp_cursor  — cursor shape change
 *   rdp_close   — session ended (error or intentional)
 *
 * Incoming commands from the browser (via webhookPoller):
 *   fuq         — frame update request (incremental|full; x/y/w/h)
 *   pe          — pointer (mouse) event
 *   ke          — key event
 *   clipboard   — local clipboard pushed to remote
 */

import { RdpBridge } from './bridge';
import { RDP_SCANCODE } from './constants';
import * as zlib from 'zlib';
import type { RdpRect, RdpConnectOptions } from './types';

export class RdpSession {
  private _bridge:      RdpBridge | null = null;
  private _active       = false;

  // Demand-driven frame pipeline (same pattern as VncSession)
  private _pendingFuq   = false;
  private _bufferedFuq: { x: number; y: number; w?: number; h?: number; inc: number } | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly wsSender: (frame: Record<string, unknown>) => boolean,
    private readonly logger?: (msg: string) => void,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────

  async start(opts: RdpConnectOptions): Promise<void> {
    const bridge = new RdpBridge();
    this._bridge = bridge;
    if (this.logger) bridge.log = this.logger;

    bridge.on('error', (err: Error) => {
      this.wsSender({ type: 'rdp_close', sessionId: this.sessionId, reason: err.message });
      this._active = false;
    });

    bridge.on('close', () => {
      if (this._active) {
        this.wsSender({ type: 'rdp_close', sessionId: this.sessionId, reason: 'rdp_disconnected' });
        this._active = false;
      }
    });

    bridge.on('clipboard', (text: string) => {
      this.wsSender({ type: 'rdp_clipboard', sessionId: this.sessionId, text });
    });

    bridge.on('cursor', (cursor: {
      hotX: number; hotY: number; width: number; height: number; rgba: string;
    }) => {
      this.wsSender({ type: 'rdp_cursor', sessionId: this.sessionId, ...cursor });
    });

    bridge.on('fbu', (rects: RdpRect[]) => {
      this._pendingFuq = false;

      // Pipeline: if the browser already queued a fuq while we were waiting,
      // send the next server-side update request immediately.
      if (this._active && this._bufferedFuq) {
        const bfq = this._bufferedFuq;
        this._bufferedFuq = null;
        // RDP pushes updates automatically — we just note that pipeline is clear.
        void bfq;
        this._pendingFuq = false;
      }

      if (rects.length === 0) return;

      // Batch-compress all rect payloads in one deflate pass (same as VncSession)
      const rectMetas: Array<{
        x: number; y: number; w: number; h: number;
        offset: number; len: number;
      }> = [];
      const parts: Buffer[] = [];
      let dataOffset = 0;

      for (const rect of rects) {
        rectMetas.push({
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          offset: dataOffset, len: rect.data.length,
        });
        parts.push(rect.data);
        dataOffset += rect.data.length;
      }

      const combined = parts.length === 1 ? parts[0] : Buffer.concat(parts);

      let data: string;
      let compressed = false;
      if (combined.length > 512) {
        const deflated = zlib.deflateRawSync(combined, { level: 1 });
        if (deflated.length < combined.length) {
          data = deflated.toString('base64');
          compressed = true;
        } else {
          data = combined.toString('base64');
        }
      } else {
        data = combined.toString('base64');
      }

      this.wsSender({
        type:      'rdp_fbu',
        sessionId: this.sessionId,
        rects:     rectMetas,
        data,
        compressed,
      });
    });

    const info = await bridge.connect(opts);
    this._active = true;

    this.wsSender({
      type:       'rdp_ready',
      sessionId:  this.sessionId,
      name:       info.name,
      width:      info.width,
      height:     info.height,
      colorDepth: info.colorDepth,
    });
  }

  handleInput(event: Record<string, unknown>): void {
    if (!this._bridge || !this._active) return;
    const t = event['type'] as string;

    if (t === 'fuq') {
      // RDP server pushes updates automatically; we just track pipeline state
      const fuqData = {
        x:   Number(event['x']   ?? 0),
        y:   Number(event['y']   ?? 0),
        w:   event['w'] ? Number(event['w']) : undefined,
        h:   event['h'] ? Number(event['h']) : undefined,
        inc: Number(event['incremental'] ?? 1),
      };
      if (!this._pendingFuq) {
        this._pendingFuq = true;
      } else {
        this._bufferedFuq = fuqData;
      }

    } else if (t === 'pe') {
      // Pointer event: { x, y, buttonMask }
      this._bridge.sendMouse(
        Number(event['x'] ?? 0),
        Number(event['y'] ?? 0),
        Number(event['buttonMask'] ?? 0),
      );

    } else if (t === 'ke') {
      // Key event: { keyCode, down }
      const jsKey = Number(event['keyCode'] ?? 0);
      // Use RDP scancode map; fall back to raw keycode
      const scan = RDP_SCANCODE[jsKey] ?? jsKey;
      void scan; // bridge handles the mapping internally
      this._bridge.sendKey(jsKey, Boolean(event['down']));

    } else if (t === 'clipboard') {
      const text = String(event['text'] ?? '');
      this._bridge.sendClipboardText(text);
    }
  }

  stop(): void {
    this._active = false;
    this._bridge?.close();
    this._bridge = null;
  }
}
