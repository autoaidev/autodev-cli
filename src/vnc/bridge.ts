/**
 * VncBridge — TCP connection to a local VNC server.
 *
 * Handles RFB protocol version negotiation (3.3 / 3.7 / 3.8) and
 * security types: None (1), VNC auth/DES (2), VeNCrypt (19).
 *
 * Emits:
 *   'frame'  (rect: VncRect)  — one decoded framebuffer rectangle
 *   'error'  (err:  Error)    — unrecoverable error (connection closed)
 *   'close'  ()               — TCP connection closed
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import {
  AUTH_NONE, AUTH_VNC, AUTH_VENCRYPT,
  VENCRYPT_TLSVNC, VENCRYPT_X509VNC,
  vncDesResponse, pickAuthType, negotiateVeNCrypt,
} from './auth';
import { ENC_RAW, ENC_COPYRECT, ENC_CURSOR } from './constants';
import type { VncRect, VncInfo } from './types';

export class VncBridge extends EventEmitter {
  private _sock: net.Socket | null = null;
  private _width  = 0;
  private _height = 0;
  private _bypp   = 4; // bytes-per-pixel (always 4 after we negotiate 32bpp)
  private _recvBuf = Buffer.alloc(0);
  private _closed  = false;

  get width()  { return this._width; }
  get height() { return this._height; }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Connect to a VNC server at 127.0.0.1:port.  Resolves once handshake is done. */
  connect(port: number, password?: string, username?: string): Promise<VncInfo> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(port, '127.0.0.1');
      this._sock = sock;

      // Pending-read queue for the async auth helpers
      const readQueue: { n: number; resolve: (b: Buffer) => void }[] = [];
      let   readBuf = Buffer.alloc(0);

      const flushReadQueue = () => {
        while (readQueue.length && readBuf.length >= readQueue[0].n) {
          const { n, resolve: res } = readQueue.shift()!;
          res(readBuf.slice(0, n));
          readBuf = readBuf.slice(n);
        }
      };

      const readExact = (n: number): Promise<Buffer> =>
        new Promise(res => { readQueue.push({ n, resolve: res }); flushReadQueue(); });

      sock.on('error', (err) => {
        if (!this._closed) { this._closed = true; this.emit('error', err); reject(err); }
      });
      sock.on('close', () => {
        if (!this._closed) { this._closed = true; this.emit('close'); }
      });

      // ── State machine ─────────────────────────────────────────────────────
      type State =
        | 'version' | 'auth37_count' | 'auth37_types'
        | 'auth_type' | 'auth_challenge' | 'auth_result' | 'auth_result38'
        | 'server_init' | 'server_name' | 'running';

      let state: State    = 'version';
      let rfbMinor        = 3;   // negotiated minor version (3, 7, or 8)
      let authTypeCount   = 0;
      let nameLen         = 0;
      let authTypePicked  = 0;

      /** Called by async VeNCrypt path to continue the synchronous state machine. */
      const continueAfterAsyncAuth = () => {
        state = 'server_init';
        processBuf();
      };

      const processBuf = () => {
        while (true) {
          if (state === 'version') {
            const nl = this._recvBuf.indexOf(0x0a);
            if (nl === -1) break;
            const verStr = this._recvBuf.slice(0, nl + 1).toString('ascii');
            this._recvBuf = this._recvBuf.slice(nl + 1);
            if (!verStr.startsWith('RFB ')) { reject(new Error('Not an RFB server')); sock.destroy(); return; }

            // Parse "RFB 003.00x\n"
            const m = verStr.match(/RFB (\d+)\.(\d+)/);
            const serverMinor = m ? parseInt(m[2]) : 3;
            rfbMinor = serverMinor >= 8 ? 8 : serverMinor >= 7 ? 7 : 3;

            sock.write(`RFB 003.00${rfbMinor}\n`);

            if (rfbMinor >= 7) {
              state = 'auth37_count';
            } else {
              state = 'auth_type'; // RFB 3.3: server sends a single 4-byte type
            }

          } else if (state === 'auth37_count') {
            if (this._recvBuf.length < 1) break;
            authTypeCount = this._recvBuf[0];
            this._recvBuf = this._recvBuf.slice(1);
            if (authTypeCount === 0) {
              // Server sent error — read reason length+string next, but just fail
              reject(new Error('VNC server rejected connection (no security types)'));
              sock.destroy(); return;
            }
            state = 'auth37_types';

          } else if (state === 'auth37_types') {
            if (this._recvBuf.length < authTypeCount) break;
            const serverTypes: number[] = [];
            for (let i = 0; i < authTypeCount; i++) serverTypes.push(this._recvBuf[i]);
            this._recvBuf = this._recvBuf.slice(authTypeCount);

            const chosen = pickAuthType(serverTypes);
            if (!chosen) {
              reject(new Error(`No supported auth type (server offers: ${serverTypes.join(', ')})`));
              sock.destroy(); return;
            }
            authTypePicked = chosen;
            sock.write(Buffer.from([chosen]));

            if (chosen === AUTH_NONE) {
              if (rfbMinor >= 8) {
                state = 'auth_result38'; // 3.8 sends a result even for None auth
              } else {
                // RFB 3.7 + None: no result sent, jump straight to ClientInit
                sock.write(Buffer.from([1])); // shared flag (1 = shared session)
                state = 'server_init';
              }
            } else if (chosen === AUTH_VNC) {
              state = 'auth_challenge';
            } else if (chosen === AUTH_VENCRYPT) {
              // Hand off to async VeNCrypt negotiator; sync loop exits here
              this._handleVeNCrypt(sock, readExact, password, username)
                .then(continueAfterAsyncAuth)
                .catch((e: Error) => { reject(e); sock.destroy(); });
              return;
            }

          } else if (state === 'auth_type') {
            // RFB 3.3 — server sends a single 4-byte auth type
            if (this._recvBuf.length < 4) break;
            const authType = this._recvBuf.readUInt32BE(0);
            this._recvBuf  = this._recvBuf.slice(4);
            authTypePicked = authType;

            if (authType === 0) { reject(new Error('VNC server rejected connection')); sock.destroy(); return; }
            if (authType === AUTH_NONE) {
              sock.write(Buffer.from([1])); // shared flag (1 = shared session)
              state = 'server_init';
            } else if (authType === AUTH_VNC) {
              state = 'auth_challenge';
            } else {
              reject(new Error(`Unsupported VNC auth type: ${authType}`)); sock.destroy(); return;
            }

          } else if (state === 'auth_challenge') {
            if (this._recvBuf.length < 16) break;
            const challenge = this._recvBuf.slice(0, 16);
            this._recvBuf   = this._recvBuf.slice(16);
            if (!password) { reject(new Error('VNC server requires a password')); sock.destroy(); return; }
            sock.write(vncDesResponse(challenge, password));
            state = rfbMinor >= 8 ? 'auth_result38' : 'auth_result';

          } else if (state === 'auth_result') {
            // RFB 3.3 / 3.7 result
            if (this._recvBuf.length < 4) break;
            const result = this._recvBuf.readUInt32BE(0);
            this._recvBuf = this._recvBuf.slice(4);
            if (result !== 0) { reject(new Error('VNC authentication failed')); sock.destroy(); return; }
            sock.write(Buffer.from([1])); // shared flag (1 = shared session)
            state = 'server_init';

          } else if (state === 'auth_result38') {
            // RFB 3.8 result (also includes reason string on failure)
            if (this._recvBuf.length < 4) break;
            const result = this._recvBuf.readUInt32BE(0);
            this._recvBuf = this._recvBuf.slice(4);
            if (result !== 0) {
              // Try to read the reason string length
              if (this._recvBuf.length < 4) break;
              const rlen   = this._recvBuf.readUInt32BE(0);
              if (this._recvBuf.length < 4 + rlen) break;
              const reason = this._recvBuf.slice(4, 4 + rlen).toString('utf8');
              this._recvBuf = this._recvBuf.slice(4 + rlen);
              reject(new Error(`VNC authentication failed: ${reason}`)); sock.destroy(); return;
            }
            sock.write(Buffer.from([1])); // shared flag (1 = shared session)
            state = 'server_init';

          } else if (state === 'server_init') {
            if (this._recvBuf.length < 24) break;
            this._width  = this._recvBuf.readUInt16BE(0);
            this._height = this._recvBuf.readUInt16BE(2);
            const bpp    = this._recvBuf[4];
            this._bypp   = bpp / 8;
            nameLen      = this._recvBuf.readUInt32BE(20);
            this._recvBuf = this._recvBuf.slice(24);
            state = 'server_name';

          } else if (state === 'server_name') {
            if (this._recvBuf.length < nameLen) break;
            const name    = this._recvBuf.slice(0, nameLen).toString('utf8');
            this._recvBuf = this._recvBuf.slice(nameLen);
            state = 'running';

            this._sendSetPixelFormat();
            this._sendSetEncodings([ENC_RAW, ENC_COPYRECT, ENC_CURSOR]);
            resolve({ name, width: this._width, height: this._height });

          } else if (state === 'running') {
            if (!this._parseServerMessage()) break;
          }
        }
      };

      sock.on('data', (chunk: Buffer) => {
        // Feed data to both the sync state machine and the async read queue
        this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
        readBuf       = Buffer.concat([readBuf, chunk]);
        flushReadQueue();
        if (state !== 'running' || !this._closed) processBuf();
      });
    });
  }

  /** Request a framebuffer update. */
  requestUpdate(x = 0, y = 0, w?: number, h?: number, incremental = 1): void {
    if (!this._sock || this._closed) return;
    const fw = w ?? this._width;
    const fh = h ?? this._height;
    const buf = Buffer.alloc(10);
    buf[0] = 3; buf[1] = incremental;
    buf.writeUInt16BE(x, 2); buf.writeUInt16BE(y, 4);
    buf.writeUInt16BE(fw, 6); buf.writeUInt16BE(fh, 8);
    this._sock.write(buf);
  }

  /** Send a key event. */
  sendKey(keysym: number, down: boolean): void {
    if (!this._sock || this._closed) return;
    const buf = Buffer.alloc(8);
    buf[0] = 4; buf[1] = down ? 1 : 0;
    buf.writeUInt32BE(keysym, 4);
    this._sock.write(buf);
  }

  /** Send a ClientCutText message (push local clipboard to remote). */
  sendClientCutText(text: string): void {
    if (!this._sock || this._closed) return;
    const encoded = Buffer.from(text, 'latin1');
    const buf = Buffer.alloc(8 + encoded.length);
    buf[0] = 6; // ClientCutText
    // buf[1..3] = padding (0)
    buf.writeUInt32BE(encoded.length, 4);
    encoded.copy(buf, 8);
    this._sock.write(buf);
  }

  /** Send a pointer (mouse) event. */
  sendMouse(x: number, y: number, buttonMask: number): void {
    if (!this._sock || this._closed) return;
    const buf = Buffer.alloc(6);
    buf[0] = 5; buf[1] = buttonMask;
    buf.writeUInt16BE(x, 2); buf.writeUInt16BE(y, 4);
    this._sock.write(buf);
  }

  close(): void {
    if (!this._closed) { this._closed = true; this._sock?.destroy(); }
  }

  // ── Private: VeNCrypt async negotiation ───────────────────────────────────

  private async _handleVeNCrypt(
    sock: net.Socket,
    readExact: (n: number) => Promise<Buffer>,
    password: string | undefined,
    username: string | undefined,
  ): Promise<void> {
    const { stream, subType } = await negotiateVeNCrypt(sock, readExact, password, username);

    // If the upgraded stream is a TLS socket, swap it in
    if (stream !== sock) {
      this._sock = stream as unknown as net.Socket;
      // Pipe new TLS data into _recvBuf
      stream.on('data', (chunk: Buffer) => {
        this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
        this._runRunning();
      });
    }

    // Inner VNC auth for TLSVNC / X509VNC
    if (subType === VENCRYPT_TLSVNC || subType === VENCRYPT_X509VNC) {
      // Server sends a 16-byte challenge
      const challenge = await new Promise<Buffer>((res, rej) => {
        const collect = (chunk: Buffer) => {
          this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
          if (this._recvBuf.length >= 16) {
            stream.off('data', collect);
            const ch = this._recvBuf.slice(0, 16);
            this._recvBuf = this._recvBuf.slice(16);
            res(ch);
          }
        };
        stream.on('data', collect);
        setTimeout(() => rej(new Error('VeNCrypt VNC challenge timeout')), 10_000);
      });
      if (!password) throw new Error('VeNCrypt VNC sub-auth requires a password');
      (stream as net.Socket).write(vncDesResponse(challenge, password));
    }

    // Read auth result (4 bytes, 0 = OK)
    const resultBuf = await new Promise<Buffer>((res, rej) => {
      const collect = (chunk: Buffer) => {
        this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
        if (this._recvBuf.length >= 4) {
          stream.off('data', collect);
          const r = this._recvBuf.slice(0, 4);
          this._recvBuf = this._recvBuf.slice(4);
          res(r);
        }
      };
      stream.on('data', collect);
      setTimeout(() => rej(new Error('VeNCrypt auth result timeout')), 10_000);
    });

    const result = resultBuf.readUInt32BE(0);
    if (result !== 0) throw new Error('VeNCrypt authentication failed');

    // Send ClientInit (shared flag = 1 = allow multiple viewers)
    (stream as net.Socket).write(Buffer.from([1]));
  }

  private _runRunning(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this._parseServerMessage()) break;
    }
  }

  // ── Private: pixel format + encodings ────────────────────────────────────

  private _sendSetPixelFormat(): void {
    if (!this._sock) return;
    const buf = Buffer.alloc(20);
    buf[0] = 0;              // SetPixelFormat
    // 3 padding bytes
    buf[4] = 32;             // bits-per-pixel
    buf[5] = 24;             // depth
    buf[6] = 0;              // big-endian flag (little-endian)
    buf[7] = 1;              // true-colour flag
    buf.writeUInt16BE(255, 8);   // red-max
    buf.writeUInt16BE(255, 10);  // green-max
    buf.writeUInt16BE(255, 12);  // blue-max
    buf[14] = 0;             // red-shift   → byte 0 = R
    buf[15] = 8;             // green-shift → byte 1 = G
    buf[16] = 16;            // blue-shift  → byte 2 = B
    //                          byte 3 = padding (0)
    this._sock.write(buf);
    this._bypp = 4;
  }

  private _sendSetEncodings(encodings: number[]): void {
    if (!this._sock) return;
    const buf = Buffer.alloc(4 + encodings.length * 4);
    buf[0] = 2; // SetEncodings
    buf.writeUInt16BE(encodings.length, 2);
    for (let i = 0; i < encodings.length; i++) buf.writeInt32BE(encodings[i], 4 + i * 4);
    this._sock.write(buf);
  }

  // ── Private: incoming server messages ────────────────────────────────────

  private _parseServerMessage(): boolean {
    if (this._recvBuf.length < 1) return false;
    const msgType = this._recvBuf[0];

    if (msgType === 0) return this._parseFBU();

    if (msgType === 2) {
      // Bell
      this._recvBuf = this._recvBuf.slice(1);
      return true;
    }

    if (msgType === 3) {
      // ServerCutText — remote clipboard changed; forward to frontend
      if (this._recvBuf.length < 8) return false;
      const len = this._recvBuf.readUInt32BE(4);
      if (this._recvBuf.length < 8 + len) return false;
      const text = this._recvBuf.slice(8, 8 + len).toString('latin1');
      this._recvBuf = this._recvBuf.slice(8 + len);
      this.emit('clipboard', text);
      return true;
    }

    this.emit('error', new Error(`Unknown RFB server message type: ${msgType}`));
    this.close();
    return false;
  }

  private _parseFBU(): boolean {
    // FramebufferUpdate header: type(1) + pad(1) + count(2) = 4 bytes
    if (this._recvBuf.length < 4) return false;
    const rectCount = this._recvBuf.readUInt16BE(2);
    let offset = 4;

    // Accumulate all rects from this FBU before emitting so the session can
    // compress them all in a single deflate operation (better ratio) and send
    // them in one WebSocket message (far fewer round-trips on busy screens).
    const rects: VncRect[] = [];

    for (let i = 0; i < rectCount; i++) {
      if (this._recvBuf.length < offset + 12) return false;
      const x   = this._recvBuf.readUInt16BE(offset);
      const y   = this._recvBuf.readUInt16BE(offset + 2);
      const w   = this._recvBuf.readUInt16BE(offset + 4);
      const h   = this._recvBuf.readUInt16BE(offset + 6);
      const enc = this._recvBuf.readInt32BE(offset + 8);
      offset += 12;

      if (enc === ENC_RAW) {
        const pixelBytes = w * h * this._bypp;
        if (this._recvBuf.length < offset + pixelBytes) return false;
        const data = Buffer.from(this._recvBuf.slice(offset, offset + pixelBytes));
        offset += pixelBytes;
        rects.push({ x, y, w, h, encoding: 'Raw', data });

      } else if (enc === ENC_COPYRECT) {
        if (this._recvBuf.length < offset + 4) return false;
        const data = Buffer.from(this._recvBuf.slice(offset, offset + 4));
        offset += 4;
        rects.push({ x, y, w, h, encoding: 'CopyRect', data });

      } else if (enc === ENC_CURSOR) {
        // Cursor pseudo-encoding: x=hotX, y=hotY, w/h=cursor size.
        // Payload: [w*h*bypp] pixel bytes + [ceil(w/8)*h] bitmask bytes.
        const maskRowBytes = Math.ceil(w / 8);
        const pixelBytes   = w * h * this._bypp;
        const maskBytes    = maskRowBytes * h;
        const totalBytes   = pixelBytes + maskBytes;
        if (this._recvBuf.length < offset + totalBytes) return false;

        const pixelData = this._recvBuf.slice(offset, offset + pixelBytes);
        const maskData  = this._recvBuf.slice(offset + pixelBytes, offset + totalBytes);
        offset += totalBytes;

        // Convert to RGBA — our pixel format: R=byte0, G=byte1, B=byte2, pad=byte3.
        // Alpha comes from the bitmask (MSB first per byte, one bit per pixel).
        const rgba = Buffer.alloc(w * h * 4);
        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const pi  = (py * w + px) * this._bypp;
            const ri  = (py * w + px) * 4;
            const bit = (maskData[py * maskRowBytes + Math.floor(px / 8)] >> (7 - (px % 8))) & 1;
            rgba[ri]     = pixelData[pi];
            rgba[ri + 1] = pixelData[pi + 1];
            rgba[ri + 2] = pixelData[pi + 2];
            rgba[ri + 3] = bit ? 255 : 0;
          }
        }

        this.emit('cursor', {
          hotX: x, hotY: y,
          width: w, height: h,
          rgba: rgba.toString('base64'),
        });
        // Cursor is a pseudo-encoding — not added to rects[]

      } else {
        this.emit('error', new Error(`Unsupported FBU encoding: ${enc}`));
        this.close();
        return false;
      }
    }

    this._recvBuf = this._recvBuf.slice(offset);
    // Always emit 'fbu' even when rects is empty (cursor-only FBU).
    // session.ts must receive this event to clear _pendingFuq; skipping it
    // when rects.length === 0 causes a permanent pipeline deadlock.
    this.emit('fbu', rects);
    return true;
  }
}
