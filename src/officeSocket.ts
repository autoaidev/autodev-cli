import * as crypto from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import { URL } from 'url';
import { buildWsUpgradeRequest } from './wsHandshake';

/**
 * OfficeSocket — a minimal, self-contained WebSocket client used by
 * `autodev mcp-operate` to hold a *presence* connection to pixel-office
 * alongside the stdio MCP bridge.
 *
 * Why this exists: MCP has no WebSocket transport and its clients are
 * turn-based, so a pure-MCP agent otherwise looks offline between polls and
 * learns about new work only when it next calls get_tasks. This side-socket
 * (the same `/ws?token=&endpoint=` channel the autodev CLI uses) makes the
 * agent show genuinely online (the server flips is_connected=true purely on
 * connect) and lets the bridge surface live task/message pushes to the client
 * as MCP notifications the instant they arrive.
 *
 * It is deliberately tiny: connect, send agent_online, answer pings, parse text
 * frames, reconnect with a fixed backoff. All the WebSocket framing is copied
 * from the CLI's proven raw implementation (no `ws` dependency in this repo).
 */

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25_000;
const PONG_GRACE_MS = 70_000;

export interface OfficeSocketOpts {
  /** Called for every decoded JSON text frame from the server. */
  onMessage: (msg: Record<string, unknown>) => void;
  /** Optional stderr logger (never stdout — that carries MCP frames). */
  log?: (line: string) => void;
  /** Extra metadata merged into the agent_online frame (provider, etc.). */
  meta?: Record<string, unknown>;
}

export class OfficeSocket {
  private _socket: net.Socket | null = null;
  private _buffer: Buffer = Buffer.alloc(0);
  private _connected = false;
  private _destroyed = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _lastPongAt = 0;
  // Reassembly state for fragmented data messages (FIN=0 + continuation frames).
  private _fragOpcode = 0;
  private _fragChunks: Buffer[] = [];

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly slug: string,
    private readonly opts: OfficeSocketOpts,
  ) {}

  start(): void {
    this._destroyed = false;
    this._connect();
  }

  /** True while a live connection is up. */
  isConnected(): boolean { return this._connected; }

  /**
   * Send a JSON payload to the server as a WebSocket text frame. Used by the
   * bridge to reply to control frames (e.g. fb_response for the office file
   * browser). No-op if the socket isn't currently connected.
   */
  sendFrame(obj: Record<string, unknown>): void { this._sendJson(obj); }

  destroy(): void {
    this._destroyed = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._closeSocket();
  }

  // ── connection ─────────────────────────────────────────────────────────────

  private _log(line: string): void { this.opts.log?.(line); }

  private _connect(): void {
    if (this._destroyed) { return; }

    let parsed: URL;
    try { parsed = new URL(this.wsUrl); }
    catch { this._log(`OfficeSocket: bad ws url "${this.wsUrl}"`); return; }

    const isSecure = parsed.protocol === 'wss:';
    const rawHost = parsed.hostname;
    const host = (rawHost === 'localhost' || rawHost === '::1') ? '127.0.0.1' : rawHost;
    const port = parsed.port ? parseInt(parsed.port, 10) : (isSecure ? 443 : 80);

    const basePath = parsed.pathname || '/';
    const qs = new URLSearchParams({ token: this.apiKey, endpoint: this.slug }).toString();
    const upgradePath = `${basePath}?${qs}`;
    const key = crypto.randomBytes(16).toString('base64');

    // Send the agent key BOTH as the ?token= query param (above, for old
    // pixel-office) AND as an X-Agent-Key header (preferred; keeps it out of URLs).
    const handshake = buildWsUpgradeRequest({
      upgradePath, host, port, secWebSocketKey: key, agentKey: this.apiKey,
    });

    const sock: net.Socket = isSecure
      ? tls.connect({ host, port, servername: host })
      : net.createConnection({ host, port });

    if (isSecure) {
      (sock as tls.TLSSocket).once('secureConnect', () => sock.write(handshake));
    } else {
      sock.once('connect', () => sock.write(handshake));
    }

    let headersDone = false;
    let headerBuf = '';

    sock.on('data', (chunk: Buffer) => {
      if (!headersDone) {
        headerBuf += chunk.toString('binary');
        const sep = headerBuf.indexOf('\r\n\r\n');
        if (sep === -1) { return; }
        if (!headerBuf.includes('101 Switching Protocols')) {
          const statusLine = headerBuf.split('\r\n')[0] ?? '(no response)';
          this._log(`OfficeSocket: upgrade rejected: "${statusLine}" — retrying in ${RECONNECT_DELAY_MS}ms`);
          sock.destroy();
          this._scheduleReconnect();
          return;
        }
        headersDone = true;
        this._connected = true;
        this._log(`OfficeSocket: presence connected (slug: ${this.slug})`);

        // agent_online → server sets status=active (is_connected is already true
        // from the connect itself). Same A2A message shape the autodev CLI sends.
        this._sendJson({
          message: {
            messageId: crypto.randomUUID(),
            contextId: this.slug,
            role: 'ROLE_AGENT',
            parts: [{ text: 'mcp agent online' }],
            metadata: { event: 'agent_online', ...(this.opts.meta ?? {}) },
          },
        });
        this._startHeartbeat();

        const remaining = Buffer.from(headerBuf.slice(sep + 4), 'binary');
        if (remaining.length > 0) { this._buffer = remaining; this._processBuffer(); }
        return;
      }
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processBuffer();
    });

    sock.on('error', (err) => {
      this._log(`OfficeSocket: error ${err.message} — retrying`);
      this._connected = false;
      this._scheduleReconnect();
    });
    sock.on('close', () => {
      if (this._connected) { this._log('OfficeSocket: disconnected — retrying'); }
      this._connected = false;
      this._scheduleReconnect();
    });

    this._socket = sock;
  }

  private _closeSocket(): void {
    if (this._socket) {
      try {
        const mask = crypto.randomBytes(4);
        this._socket.write(Buffer.from([0x88, 0x80, mask[0], mask[1], mask[2], mask[3]]));
      } catch { /* ignore */ }
      this._socket.destroy();
      this._socket = null;
    }
  }

  private _scheduleReconnect(): void {
    this._stopHeartbeat();
    this._closeSocket();
    if (this._destroyed || this._reconnectTimer) { return; }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  // ── framing (copied from the CLI's proven raw WS client) ─────────────────────

  private _processBuffer(): void {
    while (true) {
      const frame = this._parseFrame();
      if (!frame) { break; }
      this._onFrame(frame.fin, frame.opcode, frame.payload);
    }
  }

  private _parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    if (this._buffer.length < 2) { return null; }
    const byte2 = this._buffer[1];
    const fin = (this._buffer[0] & 0x80) !== 0;
    const opcode = this._buffer[0] & 0x0f;
    const isMasked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (this._buffer.length < offset + 2) { return null; }
      payloadLen = this._buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (this._buffer.length < offset + 8) { return null; }
      payloadLen = this._buffer.readUInt32BE(offset + 4);
      offset += 8;
    }

    const maskBytes = isMasked ? 4 : 0;
    if (this._buffer.length < offset + maskBytes + payloadLen) { return null; }
    const mask = isMasked ? this._buffer.slice(offset, offset + 4) : null;
    offset += maskBytes;

    let payload = this._buffer.slice(offset, offset + payloadLen);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) { payload[i] ^= mask[i % 4]; }
    }
    this._buffer = this._buffer.slice(offset + payloadLen);
    return { fin, opcode, payload };
  }

  private _onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    // Any inbound frame (data as well as control) is proof of life — refresh
    // liveness so a connection actively receiving traffic is never force-
    // reconnected by the heartbeat sweep just because protocol pongs lapsed.
    this._lastPongAt = Date.now();
    // Control frames (never fragmented) — handle immediately; they may be
    // interleaved between data fragments.
    if (opcode === 0x9) { this._sendPong(payload); this._lastPongAt = Date.now(); return; }
    if (opcode === 0xa) { this._lastPongAt = Date.now(); return; }
    if (opcode === 0x8) { this._connected = false; this._scheduleReconnect(); return; }

    // Data frames: reassemble fragmented messages (FIN=0 start + 0x0 continuations).
    let full: Buffer;
    if (opcode === 0x0) {
      // Continuation of an in-progress message.
      if (!this._fragChunks.length) { return; } // stray continuation — ignore
      this._fragChunks.push(payload);
      if (!fin) { return; }
      opcode = this._fragOpcode;
      full = Buffer.concat(this._fragChunks);
      this._fragChunks = [];
    } else if (!fin) {
      // First fragment of a new message — start accumulating.
      this._fragOpcode = opcode;
      this._fragChunks = [payload];
      return;
    } else {
      full = payload; // unfragmented single frame
    }

    if (opcode !== 0x1) { return; } // only text messages carry our JSON

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(full.toString('utf8')); }
    catch { return; }

    // Server app-level heartbeat: reply so it counts us alive.
    if (msg['type'] === 'ping') { this._sendJson({ type: 'pong' }); this._lastPongAt = Date.now(); return; }

    try { this.opts.onMessage(msg); } catch { /* listener must not kill the socket */ }
  }

  private _sendJson(obj: unknown): void { this._sendTextFrame(JSON.stringify(obj)); }

  private _sendTextFrame(text: string): void {
    if (!this._socket) { return; }
    const data = Buffer.from(text, 'utf8');
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (len <= 125) {
      header = Buffer.alloc(6); header[0] = 0x81; header[1] = len | 0x80; mask.copy(header, 2);
    } else if (len <= 65535) {
      header = Buffer.alloc(8); header[0] = 0x81; header[1] = 126 | 0x80; header.writeUInt16BE(len, 2); mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14); header[0] = 0x81; header[1] = 127 | 0x80; header.writeBigUInt64BE(BigInt(len), 2); mask.copy(header, 10);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) { masked[i] ^= mask[i % 4]; }
    try { this._socket.write(Buffer.concat([header, masked])); } catch { /* close handler reconnects */ }
  }

  private _sendPong(payload: Buffer): void {
    if (!this._socket) { return; }
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const header = Buffer.alloc(6);
    header[0] = 0x8a;
    header[1] = (len & 0x7f) | 0x80;
    mask.copy(header, 2);
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) { maskedPayload[i] ^= mask[i % 4]; }
    try { this._socket.write(Buffer.concat([header, maskedPayload])); } catch { /* ignore */ }
  }

  private _sendPing(): void {
    if (!this._socket || !this._connected) { return; }
    try {
      const mask = crypto.randomBytes(4);
      this._socket.write(Buffer.from([0x89, 0x80, mask[0], mask[1], mask[2], mask[3]]));
    } catch { /* close handler reconnects */ }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._lastPongAt = Date.now();
    this._pingTimer = setInterval(() => {
      if (Date.now() - this._lastPongAt > PONG_GRACE_MS) {
        this._log('OfficeSocket: heartbeat timeout — forcing reconnect');
        this._connected = false;
        this._scheduleReconnect();
        return;
      }
      this._sendPing();
    }, PING_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }
}
