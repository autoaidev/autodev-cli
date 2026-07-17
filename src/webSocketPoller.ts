import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VncSessionManager } from './vnc/manager';
import { RdpSessionManager } from './rdp/manager';
import { saveAttachment } from './messageBuilder';
import { shortId } from './todo';
import { todoWriter } from './todoWriteManager';
import { isKnownSlashCommand } from './core/commands';
import { handleFbRequest } from './fileBrowser';
import { handleGitRequest } from './git/gitRequest';
import { buildWsUpgradeRequest } from './wsHandshake';

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

  // VNC / RDP remote-desktop sessions are managed by shared session managers so
  // the MCP-only bridge (mcp-operate) can reuse the exact same machinery.
  private readonly _vncManager = new VncSessionManager(
    (frame) => { this.sendFrame(frame); },
    (m) => this._log(m),
  );
  private readonly _rdpManager = new RdpSessionManager(
    (frame) => { this.sendFrame(frame); },
    (m) => this._log(m),
  );
  private _gitEnabled = false;
  private _fileBrowserEnabled = false;
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
    this._vncManager.stopAll();
    this._rdpManager.stopAll();
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

    // Send the agent key BOTH as the ?token= query param (in upgradePath, for old
    // pixel-office) AND as an X-Agent-Key header (preferred; keeps it out of URLs).
    const handshake = buildWsUpgradeRequest({
      upgradePath, host, port, secWebSocketKey: key, agentKey: this.apiKey,
    });

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
    this._vncManager.stopAll();
    this._rdpManager.stopAll();
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

    // ── VNC / RDP remote-desktop frames from pixel-office ────────────────────
    // Delegated to shared session managers (same machinery the mcp-operate
    // bridge uses). Each returns true if it consumed the frame.
    if (msgType && this._vncManager.handleFrame(msgType, msg)) { return; }
    if (msgType && this._rdpManager.handleFrame(msgType, msg)) { return; }

    // ── A2A task frame ────────────────────────────────────────────────────────

    // A2A task frame: { task: { id, contextId, status: { state }, metadata: { event, task, parts } } }
    if (msg['task']) {
      const t = msg['task'] as Record<string, unknown>;
      const state = (t['status'] as Record<string, unknown> | undefined)?.['state'] as string | undefined;
      if (state !== 'TASK_STATE_SUBMITTED') { return; }

      // Deduplicate by task ID so the same delivery isn't re-processed on reconnect,
      // but a new task with identical text is still accepted.
      const taskId = t['id'] as string | undefined;
      const meta = (t['metadata'] as Record<string, unknown> | undefined) ?? {};
      if (taskId && this._seenTaskIds.has(taskId)) {
        this._log(`WS task already processed (id=${taskId}), skipping`);
        // Already queued locally, but the office is still re-delivering it (faded) —
        // that means our earlier arrival ack never landed. Re-ack so the sweep stops.
        // Idempotent server-side; only for real DB tasks (metadata.taskId present).
        if (meta['event'] === 'user_message' && typeof meta['taskId'] === 'string') {
          this._sendTaskAck(meta['taskId'] as string);
        }
        return;
      }
      // NOTE: the delivery is marked seen only AFTER it has been durably handled
      // (TODO append resolved / steer or command dispatched) — see below. Marking
      // it here at parse time meant a transient append failure permanently
      // dropped the user's message because the server's reconnect replay was
      // then skipped by the dedup check above.

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
      // The DB task id (distinct from the random A2A delivery id `taskId`). Used to
      // ACK arrival back to the office so it stops re-delivering and un-fades the
      // task. Absent on very old server frames — then we simply can't ack.
      const dbTaskId = typeof meta['taskId'] === 'string' ? meta['taskId'] as string : undefined;
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
        if (dbTaskId) { this._sendTaskAck(dbTaskId); }
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
          // Confirm arrival to the office so it stops re-delivering this task and
          // clears its "not yet delivered" fade. Idempotent server-side.
          if (dbTaskId) { this._sendTaskAck(dbTaskId); }
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
    handleFbRequest({
      root: this._workspaceRoot ?? null,
      enabled: this._fileBrowserEnabled,
      requestId,
      action,
      relPath,
      content,
      newPath,
      query,
      sendFrame: (frame) => { this.sendFrame(frame); },
      log: (m) => this._log(m),
    });
  }

  /** Handle a git-panel request from the server (originated by the browser UI). */
  private _handleGitRequest(
    requestId: string,
    action: string,
    filePath?: string,
    staged?: boolean,
    message?: string,
    branch?: string,
    hash?: string,
  ): void {
    handleGitRequest({
      root: this._workspaceRoot ?? null,
      enabled: this._gitEnabled,
      requestId,
      action,
      filePath,
      staged,
      message,
      branch,
      hash,
      sendFrame: (frame) => { this.sendFrame(frame); },
      log: (m) => this._log(m),
    });
  }

  /** Update the VNC password used for incoming vnc_session requests. */
  setVncPassword(password?: string): void {
    this._vncManager.setPassword(password);
  }

  setGitEnabled(enabled: boolean): void {
    this._gitEnabled = enabled;
  }

  setFileBrowserEnabled(enabled: boolean): void {
    this._fileBrowserEnabled = enabled;
  }

  setVncEnabled(enabled: boolean): void {
    this._vncManager.setEnabled(enabled);
  }

  setRdpEnabled(enabled: boolean): void {
    this._rdpManager.setEnabled(enabled);
  }

  setRdpSettings(s: { host?: string; port?: number; username?: string; password?: string; domain?: string; guacWsUrl?: string }): void {
    this._rdpManager.setSettings(s);
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

  /**
   * Confirm to the office that a pushed task ARRIVED in this agent's TODO queue.
   * Sent as an A2A statusUpdate (event=task_ack) so the server stamps delivered_at,
   * stops the redelivery sweep, and un-fades the task. Best-effort/idempotent.
   */
  private _sendTaskAck(dbTaskId: string): void {
    try {
      this._sendTextFrame(JSON.stringify({
        statusUpdate: {
          taskId:    dbTaskId,
          contextId: this.slug,
          status:    { state: 'TASK_STATE_WORKING' },
          metadata:  { event: 'task_ack', taskId: dbTaskId },
        },
      }));
    } catch { /* best-effort — the sweep will retry until an ack lands */ }
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
