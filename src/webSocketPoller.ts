import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VncSession } from './vnc';
import { RdpSession } from './rdp';
import type { RdpConnectOptions } from './rdp';
import { saveAttachment } from './messageBuilder';
import { shortId } from './todo';
import { todoWriter } from './todoWriteManager';
import { isKnownSlashCommand } from './core/commands';
import { resolveWithinRoot } from './core/pathSafe';
import * as gitService from './git/gitService';

// ---------------------------------------------------------------------------
// WebSocketPoller — persistent WS connection for ws:// / wss:// endpoints
// ---------------------------------------------------------------------------

export class WebSocketPoller {
  private _socket: net.Socket | null = null;
  private _connected = false;
  private _buffer = Buffer.alloc(0);
  private _todoPath = '';
  private _workspaceRoot: string | undefined;
  private _destroyed = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _log: (msg: string) => void = () => {};
  private static readonly RECONNECT_DELAY_MS = 5_000;

  private _vncPassword: string | undefined;
  private _vncSessions: Map<string, VncSession> = new Map();
  private _rdpSessions: Map<string, RdpSession> = new Map();
  private _rdpSettings: { host?: string; port?: number; username?: string; password?: string; domain?: string; guacWsUrl?: string } = {};
  private _gitEnabled = false;
  private _fileBrowserEnabled = false;
  private _vncEnabled = false;
  private _rdpEnabled = false;
  // WebSocket message reassembly (fragmented frames: FIN=0 start + 0x0 continuations).
  private _fragOpcode = 0;
  private _fragChunks: Buffer[] = [];
  private _onConnect: (() => void) | null = null;
  private _onTaskAppend: (() => void) | null = null;
  private _onSteer: ((text: string, onDelivered: () => void) => void) | null = null;
  private _onCommand: ((cmd: string) => void) | null = null;
  private _onMcpUpdate: ((entries: Record<string, unknown>) => void) | null = null;
  private _onExportRequest: ((agentId: string) => void) | null = null;
  private _onRestoreRequest: ((agentId: string, downloadUrl: string) => void) | null = null;
  private _onExportConfig: ((exportEnabled: boolean, exportDailyBackup: boolean, agentId: string) => void) | null = null;
  private _pendingFrames: unknown[] = [];
  // Delivery dedup. In-memory set for O(1) lookup + a FIFO order list that is
  // mirrored to .autodev/seen-deliveries.json so a restart / @latest respawn
  // (which starts a fresh process) does NOT re-ingest deliveries the server
  // replays on resubscribe. Bounded so it never grows without limit.
  private _seenTaskIds = new Set<string>();
  private _seenOrder: string[] = [];
  private _seenDeliveriesFile: string | null = null;
  private static readonly MAX_SEEN_DELIVERIES = 2000;

  // Heartbeat: send a WS Ping every 25 s and expect a Pong. If 2 pings in a
  // row come back without a pong (≈55 s), force-reconnect. Without this the
  // server's 10-min stale-connection sweep silently drops idle agents and the
  // client doesn't notice until the next manual restart.
  private static readonly PING_INTERVAL_MS = 25_000;
  private static readonly PONG_GRACE_MS    = 55_000;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _lastPongAt = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly slug: string,
  ) {}

  /** Called once when the WS connection is first established (and on each reconnect). */
  setOnConnect(cb: () => void): void { this._onConnect = cb; }

  /** Called whenever a task is successfully appended to TODO.md via a WS push. */
  setOnTaskAppend(cb: () => void): void { this._onTaskAppend = cb; }

  /** Called when an instant/steer message arrives — delivered live, NOT queued to TODO. */
  setOnSteer(cb: (text: string, onDelivered: () => void) => void): void { this._onSteer = cb; }

  /** Called when a slash command (e.g. /restart) is received via WS push. */
  setOnCommand(cb: (cmd: string) => void): void { this._onCommand = cb; }

  /** Called when a mcp_update frame arrives — receives the new mcpServers map. */
  setOnMcpUpdate(cb: (entries: Record<string, unknown>) => void): void { this._onMcpUpdate = cb; }

  /** Called when an export_request frame arrives — agent should create + upload a backup. */
  setOnExportRequest(cb: (agentId: string) => void): void { this._onExportRequest = cb; }

  /** Called when a restore_request frame arrives — agent should download + restore a backup. */
  setOnRestoreRequest(cb: (agentId: string, downloadUrl: string) => void): void { this._onRestoreRequest = cb; }

  /** Called when an export_config frame arrives — sync exportEnabled/exportDailyBackup settings. */
  setOnExportConfig(cb: (exportEnabled: boolean, exportDailyBackup: boolean, agentId: string) => void): void { this._onExportConfig = cb; }

  /** Start the WebSocket connection (call once). */
  start(todoPath: string, log?: (msg: string) => void, workspaceRoot?: string): void {
    this._todoPath = todoPath;
    this._workspaceRoot = workspaceRoot;
    if (log) { this._log = log; }
    this._loadSeenDeliveries();
    this._log(`WS connecting → ${this.wsUrl} (slug: ${this.slug})`);
    this._connect();
  }

  /** Reload persisted delivery IDs so a restart doesn't re-ingest replayed tasks. */
  private _loadSeenDeliveries(): void {
    if (!this._workspaceRoot) { return; }
    this._seenDeliveriesFile = path.join(this._workspaceRoot, '.autodev', 'seen-deliveries.json');
    try {
      const ids = JSON.parse(fs.readFileSync(this._seenDeliveriesFile, 'utf8')) as unknown;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && !this._seenTaskIds.has(id)) {
            this._seenTaskIds.add(id);
            this._seenOrder.push(id);
          }
        }
        this._log(`WS loaded ${this._seenOrder.length} seen delivery id(s) from disk`);
      }
    } catch { /* no file / bad json — start fresh */ }
  }

  /** Record a delivery id as processed (in-memory + persisted, bounded FIFO). */
  private _markSeenDelivery(taskId: string): void {
    if (this._seenTaskIds.has(taskId)) { return; }
    this._seenTaskIds.add(taskId);
    this._seenOrder.push(taskId);
    while (this._seenOrder.length > WebSocketPoller.MAX_SEEN_DELIVERIES) {
      const oldest = this._seenOrder.shift();
      if (oldest) { this._seenTaskIds.delete(oldest); }
    }
    if (!this._seenDeliveriesFile) { return; }
    try {
      fs.mkdirSync(path.dirname(this._seenDeliveriesFile), { recursive: true });
      fs.writeFileSync(this._seenDeliveriesFile, JSON.stringify(this._seenOrder), 'utf8');
    } catch { /* best-effort persistence */ }
  }

  /** Tear down the connection permanently. */
  destroy(): void {
    this._destroyed = true;
    this._stopHeartbeat();
    this._stopAllVncSessions();
    this._stopAllRdpSessions();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._closeSocket();
  }

  /**
   * Called by the poller loop — always returns false because the WebSocket
   * connection is event-driven; tasks are appended directly in _onFrame().
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  pollAndAppend(_todoPath: string, _workspaceRoot?: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private _connect(): void {
    if (this._destroyed) { return; }


    const parsed = new URL(this.wsUrl);
    const isSecure = parsed.protocol === 'wss:';
    // On Windows, Node.js may resolve 'localhost' to ::1 (IPv6) but the WS server
    // only binds to 0.0.0.0 (IPv4). Force 127.0.0.1 to avoid the mismatch.
    const rawHost = parsed.hostname;
    const host = (rawHost === 'localhost' || rawHost === '::1') ? '127.0.0.1' : rawHost;
    const port = parsed.port ? parseInt(parsed.port, 10) : (isSecure ? 443 : 80);

    // Build WebSocket upgrade path: preserve any existing path, append query params
    const basePath = parsed.pathname || '/';
    const qs = new URLSearchParams({ token: this.apiKey, endpoint: this.slug }).toString();
    const upgradePath = `${basePath}?${qs}`;

    const key = crypto.randomBytes(16).toString('base64');

    const handshake = [
      `GET ${upgradePath} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n');

    const sock: net.Socket = isSecure
      ? tls.connect({ host, port, servername: host })
      : net.createConnection({ host, port });

    // For plain TCP, 'connect' is the ready signal.
    // For TLS, 'secureConnect' fires after the TLS handshake; we skip the
    // plain 'connect' event to avoid writing the HTTP upgrade too early.
    if (isSecure) {
      (sock as tls.TLSSocket).once('secureConnect', () => {
        sock.write(handshake);
      });
    } else {
      sock.once('connect', () => {
        sock.write(handshake);
      });
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
          this._log(`WS upgrade rejected by ${host}:${port}: "${statusLine}" — reconnecting in ${WebSocketPoller.RECONNECT_DELAY_MS}ms`);
          sock.destroy();
          this._scheduleReconnect();
          return;
        }

        headersDone = true;
        this._connected = true;

        this._log(`WS connected → ${host}:${port} (slug: ${this.slug})`);

        // Flush any frames queued before the connection was established
        const pending = this._pendingFrames.splice(0);
        for (const frame of pending) {
          this._sendTextFrame(JSON.stringify(frame));
        }

        // Notify listener so caller can resend agent_online on reconnect
        if (this._onConnect) { this._onConnect(); }

        // Subscribe to the deliveries channel so the server pushes webhook events
        this._sendTextFrame(JSON.stringify({ type: 'subscribe', data: { channels: ['deliveries'] } }));

        // Start the WS-level keepalive (server drops idle conns after ~10 min)
        this._startHeartbeat();

        // Any bytes after the headers belong to the first WS frame
        const remaining = Buffer.from(headerBuf.slice(sep + 4), 'binary');
        if (remaining.length > 0) {
          this._buffer = remaining;
          this._processBuffer();
        }
        return;
      }

      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processBuffer();
    });

    sock.on('error', (err) => {
      this._log(`WS error (${host}:${port}): ${err.message} — reconnecting in ${WebSocketPoller.RECONNECT_DELAY_MS}ms`);
      this._connected = false;
      this._scheduleReconnect();
    });

    sock.on('close', () => {
      if (this._connected) {
        this._log(`WS disconnected from ${host}:${port} — reconnecting`);
      }
      this._connected = false;
      this._scheduleReconnect();
    });

    this._socket = sock;
  }

  private _closeSocket(): void {
    if (this._socket) {
      try {
        // Send WebSocket close frame (opcode 0x8, masked, zero-length payload)
        const mask = crypto.randomBytes(4);
        this._socket.write(Buffer.from([0x88, 0x80, mask[0], mask[1], mask[2], mask[3]]));
      } catch { /* ignore */ }
      this._socket.destroy();
      this._socket = null;
    }
  }

  private _scheduleReconnect(): void {
    this._stopHeartbeat();
    this._stopAllVncSessions();
    this._stopAllRdpSessions();
    if (this._destroyed) { return; }
    // If a reconnect is already scheduled, don't schedule another.
    if (this._reconnectTimer) { return; }

    // Detach and destroy the old socket so its stale event listeners (close/error)
    // can't trigger another _scheduleReconnect() call after we've already queued one.
    const oldSocket = this._socket;
    this._socket = null;
    this._connected = false;
    this._buffer = Buffer.alloc(0);
    if (oldSocket) {
      oldSocket.removeAllListeners('data');
      oldSocket.removeAllListeners('close');
      oldSocket.removeAllListeners('error');
      oldSocket.destroy();
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, WebSocketPoller.RECONNECT_DELAY_MS);
  }

  /** Parse and consume complete WebSocket frames from _buffer. */
  private _processBuffer(): void {
    while (true) {
      const frame = this._parseFrame();
      if (!frame) { break; }
      this._onFrame(frame.fin, frame.opcode, frame.payload);
    }
  }

  private _parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    if (this._buffer.length < 2) { return null; }

    const byte1 = this._buffer[0];
    const byte2 = this._buffer[1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const isMasked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (this._buffer.length < offset + 2) { return null; }
      payloadLen = this._buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (this._buffer.length < offset + 8) { return null; }
      // Use only the lower 32 bits (messages won't be >4 GB)
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
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    // Consume frame from buffer
    this._buffer = this._buffer.slice(offset + payloadLen);

    return { fin, opcode, payload };
  }

  private _onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    // Any inbound frame — data (task/user_message/steer/vnc_input/rdp) as well as
    // control (ping/pong) — is proof the connection is alive. Refresh liveness
    // here so a connection actively receiving traffic is never force-reconnected
    // by the heartbeat sweep just because protocol pongs lapsed (e.g. under heavy
    // VNC/RDP streaming, or a server that doesn't echo protocol pings), which
    // would tear down live screen-share sessions.
    this._lastPongAt = Date.now();
    // Control frames (never fragmented) — handle immediately; they may be
    // interleaved between data fragments.
    if (opcode === 0x9) {
      // Ping from server — reply with pong + treat as proof of life
      this._sendPong(payload);
      this._lastPongAt = Date.now();
      return;
    }
    if (opcode === 0xa) {
      // Pong from server (reply to one of our pings) — heartbeat alive
      this._lastPongAt = Date.now();
      return;
    }
    if (opcode === 0x8) {
      // Close — reconnect
      this._connected = false;
      this._scheduleReconnect();
      return;
    }

    // Data frames: reassemble fragmented messages (FIN=0 start + 0x0 continuations).
    let full: Buffer;
    if (opcode === 0x0) {
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

    if (opcode !== 0x1) { return; } // only text frames carry our JSON

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(full.toString('utf8')); }
    catch (err) { this._log(`WS frame JSON parse failed: ${err}`); return; }

    const msgType = msg['type'] as string | undefined;

    // Server app-level heartbeat: reply with a JSON pong so the server's
    // liveness sweep counts this (primary, task-carrying) connection as alive,
    // mirroring OfficeSocket. Without this the workhorse connection can be swept
    // as stale even while the WS-protocol ping/pong keeps flowing.
    if (msgType === 'ping') {
      this._sendTextFrame(JSON.stringify({ type: 'pong' }));
      this._lastPongAt = Date.now();
      return;
    }

    // Isolate all downstream frame dispatch: a single throwing frame (malformed
    // payload, ENOSPC/EACCES while saving an attachment, a containment-guard
    // throw) must never propagate out of the socket 'data' handler and crash the
    // whole agent process. Log and drop the frame instead of going offline.
    try {

    // ── VNC frames from pixel-office ─────────────────────────────────────────

    // ── MCP update from pixel-office ─────────────────────────────────────────

    if (msgType === 'mcp_update') {
      const entries = msg['mcpServers'] as Record<string, unknown> | undefined;
      if (entries && typeof entries === 'object') {
        this._onMcpUpdate?.(entries);
      }
      return;
    }

    // ── Export / restore requests from pixel-office ───────────────────────────

    if (msgType === 'export_request') {
      const agentId = msg['agentId'] as string | undefined;
      if (agentId) { this._onExportRequest?.(agentId); }
      return;
    }

    if (msgType === 'restore_request') {
      const agentId     = msg['agentId']     as string | undefined;
      const downloadUrl = msg['downloadUrl'] as string | undefined;
      if (agentId && downloadUrl) { this._onRestoreRequest?.(agentId, downloadUrl); }
      return;
    }

    if (msgType === 'export_config') {
      const exportEnabled     = !!(msg['exportEnabled'] as boolean | undefined);
      const exportDailyBackup = !!(msg['exportDailyBackup'] as boolean | undefined);
      const agentId           = (msg['agentId'] as string | undefined) ?? '';
      this._onExportConfig?.(exportEnabled, exportDailyBackup, agentId);
      return;
    }

    // ── File browser requests from server ─────────────────────────────────────

    if (msgType === 'fb_request') {
      const requestId = msg['requestId'] as string | undefined;
      const action    = msg['action']    as string | undefined;
      const relPath   = (msg['path']    as string | undefined) ?? '';
      const content   = msg['content']  as string | undefined;
      const newPath   = msg['newPath']  as string | undefined;
      const query     = msg['query']    as string | undefined;
      if (requestId && action) {
        this._handleFbRequest(requestId, action, relPath, content, newPath, query);
      }
      return;
    }

    if (msgType === 'git_request') {
      const requestId = msg['requestId'] as string | undefined;
      const action    = msg['action']    as string | undefined;
      if (requestId && action) {
        this._handleGitRequest(
          requestId,
          action,
          msg['path']    as string | undefined,
          msg['staged']  as boolean | undefined,
          msg['message'] as string | undefined,
          msg['branch']  as string | undefined,
          msg['hash']    as string | undefined,
        );
      }
      return;
    }

    if (msgType === 'vnc_session') {
      if (!this._vncEnabled) { this._log('vnc_session ignored — VNC not enabled'); return; }
      const action = msg['action'] as string | undefined;
      if (action === 'start') {
        const sessionId = msg['sessionId'] as string;
        const port      = Number(msg['port'] ?? 5900);
        // Prefer password from server frame; fall back to locally-configured password
        const password  = (msg['password'] as string | undefined) || this._vncPassword;
        this._log(`VNC session start: ${sessionId} → port ${port}`);

        const session = new VncSession(sessionId, (frame) => this.sendFrame(frame));
        this._vncSessions.set(sessionId, session);

        session.start(port, password).catch((err: Error) => {
          this._log(`VNC session ${sessionId} failed to start: ${err.message}`);
          this._vncSessions.delete(sessionId);
          this.sendFrame({ type: 'vnc_close', sessionId, reason: err.message });
        });
      }
      return;
    }

    if (msgType === 'vnc_input') {
      const sessionId = msg['sessionId'] as string | undefined;
      const event     = msg['event'] as Record<string, unknown> | undefined;
      if (sessionId && event) {
        this._vncSessions.get(sessionId)?.handleInput(event);
      }
      return;
    }

    if (msgType === 'vnc_close') {
      const sessionId = msg['sessionId'] as string | undefined;
      if (sessionId) {
        this._log(`VNC session closed: ${sessionId}`);
        this._vncSessions.get(sessionId)?.stop();
        this._vncSessions.delete(sessionId);
      }
      return;
    }

    // ── RDP frames from pixel-office ─────────────────────────────────────────

    if (msgType === 'rdp_session') {
      if (!this._rdpEnabled) { this._log('rdp_session ignored — RDP not enabled'); return; }
      const action = msg['action'] as string | undefined;
      if (action === 'start') {
        const sessionId = msg['sessionId'] as string;
        const opts: RdpConnectOptions = {
          // Host/port come ONLY from local settings — never from the WS frame.
          // A frame-supplied host/port would let a remote party open an outbound
          // RDP bridge to an arbitrary target (SSRF / internal-network pivot).
          // Default to loopback (xrdp runs on the same machine as the extension).
          host:       this._rdpSettings.host || '127.0.0.1',
          port:       this._rdpSettings.port ?? 3389,
          // credentials never sent from server — always use local settings
          username:   this._rdpSettings.username || (msg['username'] as string | undefined),
          password:   this._rdpSettings.password || (msg['password'] as string | undefined),
          domain:     this._rdpSettings.domain   || (msg['domain']   as string | undefined),
          width:      msg['width']    ? Number(msg['width'])    : undefined,
          height:     msg['height']   ? Number(msg['height'])   : undefined,
          colorDepth: msg['colorDepth'] ? Number(msg['colorDepth']) : undefined,
        };
        this._log(`RDP session start: ${sessionId} → ${opts.host}:${opts.port ?? 3389}`);

        // Send Guacamole token to browser so it can connect via guacamole-lite
        // (guacd + guacamole-lite must be running on the same host as xrdp, port 4567)
        if (opts.username || opts.password) {
          const guacSettings: Record<string, string | number | boolean> = {
            hostname:      opts.host,
            port:          String(opts.port ?? 3389),
            'ignore-cert': true,
          };
          if (opts.username) { guacSettings['username'] = opts.username; }
          if (opts.password) { guacSettings['password'] = opts.password; }
          if (opts.domain)   { guacSettings['domain']   = opts.domain; }
          if (opts.width)    { guacSettings['width']    = opts.width; }
          if (opts.height)   { guacSettings['height']   = opts.height; }
          guacSettings['color-depth'] = opts.colorDepth ?? 24;

          const tokenPayload = JSON.stringify({ connection: { type: 'rdp', settings: guacSettings } });
          const token = Buffer.from(tokenPayload).toString('base64');
          // Use configured WSS URL (for HTTPS frontends), else fall back to plain WS on port 4567
          const guacWsUrl = this._rdpSettings.guacWsUrl || `ws://${opts.host}:4567`;

          this.sendFrame({
            type:      'rdp_guac_token',
            sessionId,
            wsUrl:     guacWsUrl,
            token,
            width:     opts.width  ?? 1280,
            height:    opts.height ?? 800,
          });
          this._log(`RDP guac token sent for session ${sessionId} → ${guacWsUrl}`);
        }

        const session = new RdpSession(
          sessionId,
          (frame) => this.sendFrame(frame),
          (msg) => this._log(msg),
        );
        this._rdpSessions.set(sessionId, session);

        session.start(opts).catch((err: Error) => {
          this._log(`RDP session ${sessionId} failed to start: ${err.message}`);
          this._rdpSessions.delete(sessionId);
          this.sendFrame({ type: 'rdp_close', sessionId, reason: err.message });
        });
      }
      return;
    }

    if (msgType === 'rdp_input') {
      const sessionId = msg['sessionId'] as string | undefined;
      const event     = msg['event'] as Record<string, unknown> | undefined;
      if (sessionId && event) {
        this._rdpSessions.get(sessionId)?.handleInput(event);
      }
      return;
    }

    if (msgType === 'rdp_close') {
      const sessionId = msg['sessionId'] as string | undefined;
      if (sessionId) {
        this._log(`RDP session closed: ${sessionId}`);
        this._rdpSessions.get(sessionId)?.stop();
        this._rdpSessions.delete(sessionId);
      }
      return;
    }

    // ── A2A task frame ────────────────────────────────────────────────────────

    // A2A task frame: { task: { id, contextId, status: { state }, metadata: { event, task, parts } } }
    if (msg['task']) {
      const t = msg['task'] as Record<string, unknown>;
      const state = (t['status'] as Record<string, unknown> | undefined)?.['state'] as string | undefined;
      if (state !== 'TASK_STATE_SUBMITTED') { return; }

      // Deduplicate by task ID so the same delivery isn't re-processed on reconnect,
      // but a new task with identical text is still accepted.
      const taskId = t['id'] as string | undefined;
      if (taskId && this._seenTaskIds.has(taskId)) {
        this._log(`WS task already processed (id=${taskId}), skipping`);
        return;
      }
      // NOTE: the delivery is marked seen only AFTER it has been durably handled
      // (TODO append resolved / steer or command dispatched) — see below. Marking
      // it here at parse time meant a transient append failure permanently
      // dropped the user's message because the server's reconnect replay was
      // then skipped by the dedup check above.
      const meta = (t['metadata'] as Record<string, unknown> | undefined) ?? {};

      // ── Instant / steer message ────────────────────────────────────────────
      // Delivered live to the running turn (mid-turn injection), NOT appended to
      // TODO. Same A2A task-frame shape as a user_message but event='steer'.
      if (meta['event'] === 'steer' || meta['event'] === 'instant') {
        const steerObj = meta['task'] as Record<string, unknown> | undefined;
        let steerText = typeof steerObj?.['text'] === 'string' ? steerObj['text'] as string : '';
        if (!steerText) {
          const parts = meta['parts'] as Array<Record<string, unknown>> | undefined;
          if (parts) {
            const texts = parts
              .filter(p => p['kind'] === 'text' && typeof p['text'] === 'string')
              .map(p => p['text'] as string);
            steerText = texts.join(' ');
          }
        }
        steerText = steerText.replace(/\r\n|\r|\n/g, ' ').trim();
        if (!steerText) { return; }
        this._log(`WS steer received: "${steerText}"`);
        // At-least-once (mirror the user_message path below): mark the delivery
        // seen only AFTER the steer is durably handled — mid-turn injection or a
        // successful TODO append. On failure we leave it unseen so the server's
        // reconnect replay re-delivers it instead of silently dropping it.
        this._onSteer?.(steerText, () => { if (taskId) { this._markSeenDelivery(taskId); } });
        return;
      }

      if (meta['event'] !== 'user_message') { return; }
      const taskObj = meta['task'] as Record<string, unknown> | undefined;
      let taskText = typeof taskObj?.['text'] === 'string' ? taskObj['text'] : '';

      // Handle A2A parts — extract text parts and save file parts as attachments
      // Pre-generate task ID so all attachments share the same prefix
      const wsTaskId = shortId();
      const rawParts = meta['parts'] as Array<Record<string, unknown>> | undefined;
      const textParts: string[] = [];
      const attRefs: string[] = [];
      if (rawParts) {
        for (const part of rawParts) {
          if (part['kind'] === 'text') {
            const t = (part['text'] as string | undefined) ?? '';
            if (t) { textParts.push(t); }
          } else if (part['kind'] === 'file' && this._workspaceRoot) {
            const file = part['file'] as Record<string, unknown> | undefined;
            if (file) {
              const name = (file['name'] as string | undefined) ?? 'attachment';
              const bytesB64 = file['bytes'] as string | undefined;
              if (bytesB64) {
                const buf = Buffer.from(bytesB64, 'base64');
                const rel = saveAttachment(this._workspaceRoot, name, buf, wsTaskId);
                attRefs.push(rel);
              } else if (typeof file['uri'] === 'string') {
                attRefs.push(file['uri'] as string);
              }
            }
          }
        }
      }

      // Use parts text only as fallback when task.text is absent
      if (!taskText && textParts.length > 0) { taskText = textParts.join(' '); }
      if (!taskText) { return; }
      // Collapse newlines so the entire message becomes a single TODO.md line
      taskText = taskText.replace(/\r\n|\r|\n/g, ' ').trim();
      const fullText = attRefs.length > 0
        ? taskText + ' ' + attRefs.map(p => `[attachment: ${p}]`).join(' ')
        : taskText;

      this._log(`WS task received: "${taskText}"${attRefs.length > 0 ? ` (+${attRefs.length} attachment(s))` : ''}`);

      // Divert ONLY exact known control commands (/restart, /clear, /retry, …).
      // Any other slash-prefixed text ("/login is broken", "/etc/nginx ...") is
      // an ordinary task and must still be queued — never silently discarded.
      if (isKnownSlashCommand(fullText)) {
        if (taskId) { this._markSeenDelivery(taskId); }
        this._onCommand?.(fullText);
        return;
      }

      if (!this._todoPath) { this._log('WS failed to append task to TODO.md: todoPath is empty'); return; }
      todoWriter.append(this._todoPath, fullText, wsTaskId)
        .then(() => {
          // At-least-once: only record the delivery as seen AFTER the durable
          // TODO append succeeds. On failure we leave it unseen so the server's
          // reconnect replay re-delivers it instead of dropping it.
          if (taskId) { this._markSeenDelivery(taskId); }
          this._onTaskAppend?.();
        })
        .catch(err => { this._log(`WS failed to append task to TODO.md: ${err}`); });
    }

    } catch (err) {
      // A bad frame must never take down the socket/process — see the try above.
      this._log(`WS frame dispatch failed (type=${msgType ?? 'unknown'}): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  /** Handle a file-browser request from the server (originated by the browser UI). */
  private _handleFbRequest(requestId: string, action: string, relPath: string, content?: string, newPath?: string, query?: string): void {
    const respond = (ok: boolean, extra?: Record<string, unknown>) => {
      this.sendFrame({ type: 'fb_response', requestId, ok, ...extra });
    };

    if (!this._fileBrowserEnabled) {
      respond(false, { error: 'File browser not enabled' });
      return;
    }

    const root = this._workspaceRoot;
    if (!root) {
      respond(false, { error: 'No workspace root configured' });
      return;
    }

    // Resolve and validate path is within workspace root. The root itself is
    // permitted for read-only actions (list/search) but never for mutations.
    // Containment is lexical AND canonical (realpath) — a workspace symlink
    // pointing outside must not let a remote fb_request read/write host files.
    const resolveSafe = (rel: string, allowRoot: boolean): string | null =>
      resolveWithinRoot(root, rel, allowRoot);

    const MUTATING = new Set(['write', 'delete', 'rename', 'mkdir']);
    const allowRoot = !MUTATING.has(action);
    const absPath = resolveSafe(relPath, allowRoot);
    if (!absPath) {
      respond(false, {
        error: allowRoot ? 'Path outside workspace' : 'Refusing to modify workspace root',
      });
      return;
    }

    try {
      switch (action) {
        case 'list': {
          const entries = fs.readdirSync(absPath, { withFileTypes: true }).map(e => {
            const stat = (() => { try { return fs.statSync(path.join(absPath, e.name)); } catch { return null; } })();
            return {
              name: e.name,
              type: e.isDirectory() ? 'dir' : 'file',
              size: stat?.size ?? 0,
              mtime: stat?.mtimeMs ?? 0,
            };
          });
          // Dirs first, then files; both alphabetical
          entries.sort((a, b) => {
            if (a.type !== b.type) { return a.type === 'dir' ? -1 : 1; }
            return a.name.localeCompare(b.name);
          });
          respond(true, { entries });
          break;
        }

        case 'read': {
          const stat = fs.statSync(absPath);
          const MAX_BYTES = 1_048_576; // 1 MB
          if (stat.size > MAX_BYTES) {
            respond(false, { error: `File too large (${stat.size} bytes, limit 1 MB)` });
            break;
          }
          // Binary detection: read first 512 bytes and check for null bytes
          const sample = Buffer.allocUnsafe(Math.min(512, stat.size));
          const fd = fs.openSync(absPath, 'r');
          fs.readSync(fd, sample, 0, sample.length, 0);
          fs.closeSync(fd);
          const isBinary = sample.includes(0x00);
          if (isBinary) {
            respond(false, { error: 'Binary file — cannot display' });
            break;
          }
          const fileContent = fs.readFileSync(absPath, 'utf8');
          respond(true, { content: fileContent });
          break;
        }

        case 'write': {
          if (content === undefined) {
            respond(false, { error: 'No content provided' });
            break;
          }
          fs.writeFileSync(absPath, content, 'utf8');
          respond(true);
          break;
        }

        case 'delete': {
          fs.rmSync(absPath, { recursive: true, force: true });
          respond(true);
          break;
        }

        case 'rename': {
          if (!newPath) {
            respond(false, { error: 'No newPath provided' });
            break;
          }
          const absNewPath = resolveSafe(newPath, false);
          if (!absNewPath) {
            respond(false, { error: 'newPath outside workspace' });
            break;
          }
          fs.renameSync(absPath, absNewPath);
          respond(true);
          break;
        }

        case 'download': {
          const stat = fs.statSync(absPath);
          const MAX_DOWNLOAD_BYTES = 25 * 1_048_576; // 25 MB — base64 ~1.33x in heap
          if (stat.size > MAX_DOWNLOAD_BYTES) {
            respond(false, { error: `File too large (${stat.size} bytes, limit 25 MB)` });
            break;
          }
          const buf = fs.readFileSync(absPath);
          respond(true, { base64: buf.toString('base64') });
          break;
        }

        case 'mkdir': {
          fs.mkdirSync(absPath, { recursive: true });
          respond(true);
          break;
        }

        case 'search': {
          const rawQuery = (query ?? '').toLowerCase().trim();
          if (!rawQuery) { respond(true, { results: [] }); break; }
          const results: { path: string; name: string; type: string }[] = [];
          const walk = (dir: string, relDir: string, depth: number) => {
            if (depth > 8 || results.length >= 300) return;
            let dirents: fs.Dirent[];
            try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of dirents) {
              if (results.length >= 300) break;
              const rel = relDir ? `${relDir}/${e.name}` : e.name;
              if (e.name.toLowerCase().includes(rawQuery)) {
                results.push({ path: rel, name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
              }
              if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor') {
                walk(path.join(dir, e.name), rel, depth + 1);
              }
            }
          };
          walk(absPath, '', 0);
          respond(true, { results });
          break;
        }

        default:
          respond(false, { error: `Unknown action: ${action}` });
      }
    } catch (err) {
      respond(false, { error: String(err) });
    }
  }

  private _handleGitRequest(
    requestId: string,
    action: string,
    filePath?: string,
    staged?: boolean,
    message?: string,
    branch?: string,
    hash?: string,
  ): void {
    const respond = (ok: boolean, data?: Record<string, unknown>, error?: string) => {
      this.sendFrame({ type: 'git_response', requestId, ok, ...(data ?? {}), ...(error ? { error } : {}) });
    };

    const root = this._workspaceRoot;
    if (!root) { respond(false, undefined, 'No workspace root'); return; }
    if (!this._gitEnabled) { respond(false, undefined, 'Git not enabled'); return; }

    // Containment guard — mirror _handleFbRequest. Every path-bearing arg
    // (filePath) must resolve inside the workspace root both lexically AND after
    // resolving symlinks; otherwise a git_request could read arbitrary host
    // files (e.g. path '../../.claude/.credentials.json' via the readFileSync
    // fallback in getDiff, or leak them through `git diff -- <path>`). An empty
    // filePath means "whole repo" and is permitted (allowRoot).
    if (filePath !== undefined && filePath !== '') {
      if (resolveWithinRoot(root, filePath, true) === null) {
        respond(false, undefined, 'Path outside workspace');
        return;
      }
    }

    (async () => {
      try {
        switch (action) {
          case 'status': {
            const status = await gitService.getStatus(root);
            respond(true, { status });
            break;
          }
          case 'log': {
            const commits = await gitService.getLog(root);
            respond(true, { commits });
            break;
          }
          case 'diff': {
            const diff = await gitService.getDiff(root, filePath ?? '', staged ?? false);
            respond(true, { diff });
            break;
          }
          case 'commit_diff': {
            const diff = await gitService.getCommitDiff(root, hash ?? '', filePath);
            respond(true, { diff });
            break;
          }
          case 'stage': {
            if (filePath) await gitService.stageFile(root, filePath);
            else await gitService.stageAll(root);
            respond(true);
            break;
          }
          case 'unstage': {
            if (!filePath) { respond(false, undefined, 'path required'); break; }
            await gitService.unstageFile(root, filePath);
            respond(true);
            break;
          }
          case 'commit': {
            if (!message) { respond(false, undefined, 'message required'); break; }
            const commitHash = await gitService.commit(root, message);
            respond(true, { hash: commitHash });
            break;
          }
          case 'fetch': {
            await gitService.fetchOrigin(root);
            respond(true);
            break;
          }
          case 'branches': {
            const branches = await gitService.getBranches(root);
            respond(true, { branches });
            break;
          }
          case 'checkout': {
            if (!branch) { respond(false, undefined, 'branch required'); break; }
            await gitService.checkoutBranch(root, branch);
            respond(true);
            break;
          }
          default:
            respond(false, undefined, `Unknown git action: ${action}`);
        }
      } catch (err) {
        respond(false, undefined, String(err));
      }
    })();
  }

  /** Stop all active VNC sessions (called on destroy/reconnect). */
  private _stopAllVncSessions(): void {
    for (const [id, session] of this._vncSessions) {
      this._log(`VNC session terminated (disconnect): ${id}`);
      session.stop();
    }
    this._vncSessions.clear();
  }

  /** Stop all active RDP sessions (called on destroy/reconnect). */
  private _stopAllRdpSessions(): void {
    for (const [id, session] of this._rdpSessions) {
      this._log(`RDP session terminated (disconnect): ${id}`);
      session.stop();
    }
    this._rdpSessions.clear();
  }

  /** Update the VNC password used for incoming vnc_session requests. */
  setVncPassword(password?: string): void {
    this._vncPassword = password;
  }

  setGitEnabled(enabled: boolean): void {
    this._gitEnabled = enabled;
  }

  setFileBrowserEnabled(enabled: boolean): void {
    this._fileBrowserEnabled = enabled;
  }

  setVncEnabled(enabled: boolean): void {
    this._vncEnabled = enabled;
  }

  setRdpEnabled(enabled: boolean): void {
    this._rdpEnabled = enabled;
  }

  setRdpSettings(s: { host?: string; port?: number; username?: string; password?: string; domain?: string; guacWsUrl?: string }): void {
    this._rdpSettings = s;
  }

  /**
   * Send a JSON payload to the server over the WebSocket connection.
   * Queues the frame if not yet connected — always returns true (accepted).
   */
  private static readonly MAX_PENDING_FRAMES = 200;

  sendFrame(payload: unknown): boolean {
    if (!this._connected || !this._socket) {
      // Cap the queue to prevent unbounded growth during a long reconnect loop.
      if (this._pendingFrames.length >= WebSocketPoller.MAX_PENDING_FRAMES) {
        this._pendingFrames.shift(); // drop oldest frame
      }
      this._pendingFrames.push(payload);
      return true;  // accepted into queue
    }
    this._sendTextFrame(JSON.stringify(payload));
    return true;
  }

  /** Send a masked WebSocket text frame. */
  private _sendTextFrame(text: string): void {
    if (!this._socket) { return; }

    const data = Buffer.from(text, 'utf8');
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (len <= 125) {
      header = Buffer.alloc(6);
      header[0] = 0x81;
      header[1] = len | 0x80;
      mask.copy(header, 2);
    } else if (len <= 65535) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 126 | 0x80;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 127 | 0x80;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) { masked[i] ^= mask[i % 4]; }
    this._socket.write(Buffer.concat([header, masked]));
  }

  private _sendPong(payload: Buffer): void {
    if (!this._socket) { return; }
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const header = Buffer.alloc(2 + 4);
    header[0] = 0x8a; // FIN + pong opcode
    header[1] = (len & 0x7f) | 0x80; // masked, length (assumes len <= 125)
    mask.copy(header, 2);
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) { maskedPayload[i] ^= mask[i % 4]; }
    this._socket.write(Buffer.concat([header, maskedPayload]));
  }

  /** Send a zero-payload Ping frame. Server's WS server replies with Pong. */
  private _sendPing(): void {
    if (!this._socket || !this._connected) { return; }
    try {
      // FIN + opcode 0x9 (ping), masked, zero-length payload
      const mask = crypto.randomBytes(4);
      this._socket.write(Buffer.from([0x89, 0x80, mask[0], mask[1], mask[2], mask[3]]));
    } catch { /* socket may be dead — close handler will reconnect */ }
  }

  /** Start the heartbeat. Cleared automatically on close/destroy/reconnect. */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._lastPongAt = Date.now();
    this._pingTimer = setInterval(() => {
      // If the server hasn't responded in PONG_GRACE_MS, the link is dead
      // even though TCP still thinks we're connected (proxy/NAT timeout).
      const silence = Date.now() - this._lastPongAt;
      if (silence > WebSocketPoller.PONG_GRACE_MS) {
        this._log(`WS heartbeat timeout (no pong for ${Math.round(silence/1000)}s) — forcing reconnect`);
        this._connected = false;
        this._scheduleReconnect();
        return;
      }
      this._sendPing();
    }, WebSocketPoller.PING_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }
}
