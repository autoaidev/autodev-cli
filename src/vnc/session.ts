/**
 * VncSession — one tunnel: VncBridge ↔ WS sender ↔ pixel-office.
 *
 * Wraps a single VncBridge instance and drives the demand-driven
 * framebuffer update cycle (browser sends 'fuq' → request → frame → ack).
 */

import { VncBridge } from './bridge';
import { KEYSYM } from './constants';
import * as zlib from 'zlib';
import type { VncRect } from './types';

export class VncSession {
  private _bridge: VncBridge | null = null;
  private _active     = false;
  private _pendingFuq = false; // true while a VNC FBU reply is in flight

  // 1-deep pipeline buffer: a fuq that arrived while _pendingFuq was true.
  // Dispatched immediately when the outstanding FBU reply arrives.
  private _bufferedFuq: { x: number; y: number; w?: number; h?: number; inc: number } | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly wsSender: (frame: Record<string, unknown>) => boolean,
  ) {}

  async start(port: number, password?: string, username?: string): Promise<void> {
    const bridge = new VncBridge();
    this._bridge = bridge;

    bridge.on('error', (err: Error) => {
      this.wsSender({ type: 'vnc_close', sessionId: this.sessionId, reason: err.message });
      this._active = false;
    });

    bridge.on('close', () => {
      if (this._active) {
        this.wsSender({ type: 'vnc_close', sessionId: this.sessionId, reason: 'vnc_disconnected' });
        this._active = false;
      }
    });

    // Bidirectional clipboard: remote changed → tell browser
    bridge.on('clipboard', (text: string) => {
      this.wsSender({ type: 'vnc_clipboard', sessionId: this.sessionId, text });
    });

    // Cursor shape: remote changed cursor → tell browser
    bridge.on('cursor', (cursor: {
      hotX: number; hotY: number; width: number; height: number; rgba: string;
    }) => {
      this.wsSender({ type: 'vnc_cursor', sessionId: this.sessionId, ...cursor });
    });

    bridge.on('fbu', (rects: VncRect[]) => {
      this._pendingFuq = false;

      // Pipeline: if the browser already queued a fuq while we were waiting
      // for this VNC reply, dispatch the next VNC request immediately so the
      // VNC server is processing it while we encode and ship the current batch.
      if (this._active && this._bufferedFuq) {
        const bfq = this._bufferedFuq;
        this._bufferedFuq = null;
        bridge.requestUpdate(bfq.x, bfq.y, bfq.w, bfq.h, bfq.inc);
        this._pendingFuq = true;
      }

      // Cursor-only FBU (rects is empty) — pipeline is unblocked above;
      // nothing to send to the browser.
      if (rects.length === 0) return;

      // Concatenate all rect payloads and compress in a SINGLE deflate pass.
      // Batching gives the compressor cross-rect spatial context and avoids
      // per-rect setup overhead — significantly better compression ratio.
      const rectMetas: Array<{
        x: number; y: number; w: number; h: number;
        encoding: string; offset: number; len: number;
      }> = [];
      const parts: Buffer[] = [];
      let dataOffset = 0;

      for (const rect of rects) {
        rectMetas.push({
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          encoding: rect.encoding,
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
        type:      'vnc_fbu',
        sessionId: this.sessionId,
        rects:     rectMetas,
        data,
        compressed,
      });
    });

    const info = await bridge.connect(port, password, username);
    this._active = true;

    this.wsSender({
      type:      'vnc_ready',
      sessionId: this.sessionId,
      name:      info.name,
      width:     info.width,
      height:    info.height,
    });

    // Request initial full framebuffer (incremental=0)
    bridge.requestUpdate(0, 0, info.width, info.height, 0);
    this._pendingFuq = true;
  }

  handleInput(event: Record<string, unknown>): void {
    if (!this._bridge || !this._active) return;
    const t = event['type'] as string;

    if (t === 'fuq') {
      const fuqData = {
        x:   Number(event['x']   ?? 0),
        y:   Number(event['y']   ?? 0),
        w:   event['w'] ? Number(event['w']) : undefined,
        h:   event['h'] ? Number(event['h']) : undefined,
        inc: Number(event['incremental'] ?? 1),
      };

      if (!this._pendingFuq) {
        // Nothing in flight — send to VNC immediately
        this._bridge.requestUpdate(fuqData.x, fuqData.y, fuqData.w, fuqData.h, fuqData.inc);
        this._pendingFuq = true;
      } else {
        // Buffer it: the fbu handler will dispatch it as soon as the
        // outstanding VNC reply arrives (1-deep pipeline).
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
      const jsKey  = Number(event['keyCode'] ?? 0);
      const keysym = KEYSYM[jsKey] ?? jsKey;
      this._bridge.sendKey(keysym, Boolean(event['down']));

    } else if (t === 'clipboard') {
      // Local clipboard pushed to remote: { text }
      const text = String(event['text'] ?? '');
      this._bridge.sendClientCutText(text);
    }
  }

  stop(): void {
    this._active = false;
    this._bridge?.close();
    this._bridge = null;
  }
}
