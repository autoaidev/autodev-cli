import { RdpSession } from './session';
import type { RdpConnectOptions } from './types';

// ---------------------------------------------------------------------------
// RdpSessionManager — shared RDP remote-desktop session manager.
//
// Mirrors VncSessionManager. The office RDP viewer drives a remote desktop over
// the agent's WS channel with rdp_session (start), rdp_input (forwarding) and
// rdp_close (teardown) frames. A LOOP agent receives these on its
// WebSocketPoller; an MCP-only agent on its OfficeSocket presence connection.
// Both delegate here so behaviour is identical regardless of transport.
//
// The manager owns the sessionId→RdpSession map plus the locally-configured RDP
// settings (host/port/credentials/guac URL), and is gated by `enabled`.
// Host/port/credentials come ONLY from local settings — never from the WS frame
// — so a remote party cannot open an outbound RDP bridge to an arbitrary target
// (SSRF / internal-network pivot).
// ---------------------------------------------------------------------------

export interface RdpManagerSettings {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
  guacWsUrl?: string;
}

export class RdpSessionManager {
  private _sessions: Map<string, RdpSession> = new Map();
  private _settings: RdpManagerSettings = {};
  private _enabled = false;

  constructor(
    private readonly sendFrame: (frame: Record<string, unknown>) => void,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Enable/disable RDP. Session-start frames are ignored while disabled. */
  setEnabled(enabled: boolean): void { this._enabled = enabled; }

  /** Update the RDP connection settings (host/port/credentials/guac URL). */
  setSettings(s: RdpManagerSettings): void { this._settings = s; }

  /**
   * Dispatch an RDP control frame. Returns true if `msgType` was an RDP frame
   * (and was consumed), false otherwise so the caller can keep matching.
   */
  handleFrame(msgType: string, msg: Record<string, unknown>): boolean {
    switch (msgType) {
      case 'rdp_session': this._onSession(msg); return true;
      case 'rdp_input':   this._onInput(msg);   return true;
      case 'rdp_close':   this._onClose(msg);   return true;
      default: return false;
    }
  }

  private _onSession(msg: Record<string, unknown>): void {
    if (!this._enabled) { this.log('rdp_session ignored — RDP not enabled'); return; }
    const action = msg['action'] as string | undefined;
    if (action !== 'start') { return; }

    const sessionId = msg['sessionId'] as string;
    const opts: RdpConnectOptions = {
      // Host/port come ONLY from local settings — never from the WS frame.
      // A frame-supplied host/port would let a remote party open an outbound
      // RDP bridge to an arbitrary target (SSRF / internal-network pivot).
      // Default to loopback (xrdp runs on the same machine as the extension).
      host:       this._settings.host || '127.0.0.1',
      port:       this._settings.port ?? 3389,
      // credentials never sent from server — always use local settings
      username:   this._settings.username || (msg['username'] as string | undefined),
      password:   this._settings.password || (msg['password'] as string | undefined),
      domain:     this._settings.domain   || (msg['domain']   as string | undefined),
      width:      msg['width']    ? Number(msg['width'])    : undefined,
      height:     msg['height']   ? Number(msg['height'])   : undefined,
      colorDepth: msg['colorDepth'] ? Number(msg['colorDepth']) : undefined,
    };
    this.log(`RDP session start: ${sessionId} → ${opts.host}:${opts.port ?? 3389}`);

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
      const guacWsUrl = this._settings.guacWsUrl || `ws://${opts.host}:4567`;

      this.sendFrame({
        type:      'rdp_guac_token',
        sessionId,
        wsUrl:     guacWsUrl,
        token,
        width:     opts.width  ?? 1280,
        height:    opts.height ?? 800,
      });
      this.log(`RDP guac token sent for session ${sessionId} → ${guacWsUrl}`);
    }

    const session = new RdpSession(
      sessionId,
      (frame) => { this.sendFrame(frame); return true; },
      (m) => this.log(m),
    );
    this._sessions.set(sessionId, session);

    session.start(opts).catch((err: Error) => {
      this.log(`RDP session ${sessionId} failed to start: ${err.message}`);
      this._sessions.delete(sessionId);
      this.sendFrame({ type: 'rdp_close', sessionId, reason: err.message });
    });
  }

  private _onInput(msg: Record<string, unknown>): void {
    const sessionId = msg['sessionId'] as string | undefined;
    const event     = msg['event'] as Record<string, unknown> | undefined;
    if (sessionId && event) {
      this._sessions.get(sessionId)?.handleInput(event);
    }
  }

  private _onClose(msg: Record<string, unknown>): void {
    const sessionId = msg['sessionId'] as string | undefined;
    if (sessionId) {
      this.log(`RDP session closed: ${sessionId}`);
      this._sessions.get(sessionId)?.stop();
      this._sessions.delete(sessionId);
    }
  }

  /** Stop all active RDP sessions (called on destroy/reconnect). */
  stopAll(): void {
    for (const [id, session] of this._sessions) {
      this.log(`RDP session terminated (disconnect): ${id}`);
      session.stop();
    }
    this._sessions.clear();
  }
}
