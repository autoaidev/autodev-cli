// ---------------------------------------------------------------------------
// DiscordGateway — minimal Discord Gateway WebSocket client
//
// Purpose: keep the bot status as "online" in Discord.
// The DiscordPoller only uses REST (HTTP polling), which never tells Discord
// the bot is connected.  A Gateway WebSocket connection is the only way to
// set the bot's presence to "online".
//
// This class handles:
//   • Connecting to wss://gateway.discord.gg
//   • HELLO  (op 10) → start heartbeat loop
//   • IDENTIFY (op 2) with presence {status: 'online'}
//   • Heartbeat / ACK cycle (zombie-detection)
//   • RECONNECT (op 7) and INVALID_SESSION (op 9)
//   • Automatic reconnect with jitter on unexpected close
// ---------------------------------------------------------------------------

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Discord Gateway opcodes
const OP_DISPATCH         = 0;
const OP_HEARTBEAT        = 1;
const OP_IDENTIFY         = 2;
const OP_RESUME           = 6;
const OP_RECONNECT        = 7;
const OP_INVALID_SESSION  = 9;
const OP_HELLO            = 10;
const OP_HEARTBEAT_ACK    = 11;

// Non-resumable close codes per Discord docs
const NON_RESUMABLE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// Node 22+ (Electron 34 / VS Code 1.99+) exposes WebSocket as a global.
// Declare a minimal shape so TypeScript is happy without a DOM lib.
declare const WebSocket: new (url: string) => {
  onopen:    (() => void) | null;
  onclose:   ((ev: { code: number }) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror:   ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
  readonly readyState: number; // 0 CONNECTING | 1 OPEN | 2 CLOSING | 3 CLOSED
};

// Backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 60 s (cap)
const RECONNECT_BASE_MS  = 1_000;
const RECONNECT_MAX_MS   = 60_000;

export class DiscordGateway {
  private ws:               InstanceType<typeof WebSocket> | null = null;
  private heartbeatTimer:   NodeJS.Timeout | null = null;
  private jitterTimer:      NodeJS.Timeout | null = null;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private ackReceived       = true;
  private sequence:         number | null = null;
  private sessionId:        string | null = null;
  private resumeGatewayUrl: string | null = null;
  private destroyed         = false;
  private reconnectAttempts = 0;

  constructor(private readonly botToken: string) {}

  /** Open the gateway connection. Safe to call multiple times. */
  connect(): void {
    this.destroyed = false;
    this.reconnectAttempts = 0;
    this._connect(this.resumeGatewayUrl ?? GATEWAY_URL);
  }

  /** Close the connection permanently (e.g. loop stopped). */
  destroy(): void {
    this.destroyed = true;
    this._cleanup();
  }

  // ---------------------------------------------------------------------------

  private _connect(gatewayUrl: string): void {
    this._cleanup();
    const ws = new WebSocket(gatewayUrl);
    this.ws = ws;

    ws.onmessage = (ev) => {
      try { this._handle(JSON.parse(ev.data)); } catch { /* ignore */ }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) { return; } // stale close — a newer connection is already active
      if (NON_RESUMABLE_CODES.has(ev.code)) {
        this.sessionId        = null;
        this.resumeGatewayUrl = null;
        this.sequence         = null;
      }
      if (!this.destroyed) { this._scheduleReconnect(); }
    };

    ws.onerror = () => { /* onclose will follow */ };
    ws.onopen  = () => { /* wait for HELLO */ };
  }

  private _handle(p: { op: number; d: unknown; s?: number | null; t?: string | null }): void {
    if (p.s != null) { this.sequence = p.s; }

    switch (p.op) {
      case OP_HELLO: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        this._startHeartbeat(interval);
        if (this.sessionId && this.sequence != null) {
          this._send({ op: OP_RESUME, d: { token: this.botToken, session_id: this.sessionId, seq: this.sequence } });
        } else {
          this._identify();
        }
        break;
      }
      case OP_DISPATCH: {
        if (p.t === 'READY') {
          const d = p.d as { session_id: string; resume_gateway_url: string };
          this.sessionId        = d.session_id;
          this.resumeGatewayUrl = d.resume_gateway_url;
          this.reconnectAttempts = 0; // successful connection — reset backoff
        }
        break;
      }
      case OP_HEARTBEAT:     { this._sendHeartbeat();          break; }
      case OP_HEARTBEAT_ACK: { this.ackReceived = true;        break; }
      case OP_RECONNECT:     { this._scheduleReconnect(true);  break; }
      case OP_INVALID_SESSION: {
        if (!p.d) {
          this.sessionId        = null;
          this.resumeGatewayUrl = null;
          this.sequence         = null;
        }
        // Wait 1-5 s before reconnecting as required by Discord docs
        setTimeout(() => { if (!this.destroyed) { this._connect(GATEWAY_URL); } },
          1000 + Math.random() * 4000);
        break;
      }
    }
  }

  private _identify(): void {
    this._send({
      op: OP_IDENTIFY,
      d: {
        token:      this.botToken,
        intents:    512,   // GUILD_MESSAGES (non-privileged; only needed for identification)
        properties: { os: 'linux', browser: 'autodev', device: 'autodev' },
        presence:   { status: 'online', afk: false, since: null, activities: [] },
      },
    });
  }

  private _startHeartbeat(interval: number): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer);  this.heartbeatTimer = null; }
    if (this.jitterTimer)    { clearTimeout(this.jitterTimer);       this.jitterTimer    = null; }
    this.ackReceived = true;

    // Initial jitter per Discord docs
    const jitter = Math.floor(Math.random() * interval);
    this.jitterTimer = setTimeout(() => {
      this.jitterTimer = null;
      if (this.destroyed) { return; }
      this._sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.ackReceived) {
          // Zombie connection — force reconnect
          this._scheduleReconnect(true);
          return;
        }
        this.ackReceived = false;
        this._sendHeartbeat();
      }, interval);
    }, jitter);
  }

  private _sendHeartbeat(): void {
    this._send({ op: OP_HEARTBEAT, d: this.sequence });
  }

  private _send(data: object): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private _scheduleReconnect(immediate = false): void {
    this._cleanup();
    if (this.destroyed) { return; }
    let delay: number;
    if (immediate) {
      delay = 0;
    } else {
      // Exponential backoff with jitter: 1s, 2s, 4s … capped at 60s
      const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
      delay = base * (0.5 + Math.random() * 0.5); // 50–100 % of base
    }
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this._connect(this.resumeGatewayUrl ?? GATEWAY_URL);
    }, delay);
  }

  private _cleanup(): void {
    if (this.heartbeatTimer)  { clearInterval(this.heartbeatTimer);   this.heartbeatTimer  = null; }
    if (this.jitterTimer)     { clearTimeout(this.jitterTimer);        this.jitterTimer     = null; }
    if (this.reconnectTimer)  { clearTimeout(this.reconnectTimer);     this.reconnectTimer  = null; }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }
}
