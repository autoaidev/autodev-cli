import { VncSession } from './session';

// ---------------------------------------------------------------------------
// VncSessionManager — shared VNC remote-desktop session manager.
//
// The office VNC viewer (browser UI) drives a remote desktop over the agent's
// WS channel with three frame types: vnc_session (start), vnc_input (keyboard/
// mouse/framebuffer-request forwarding) and vnc_close (teardown). A LOOP agent
// receives these on its WebSocketPoller; an MCP-only agent receives them on its
// OfficeSocket presence connection. Both delegate to this manager so behaviour
// is identical regardless of the transport.
//
// The manager owns the sessionId→VncSession map plus the locally-configured
// password, and is gated by `enabled` (an ungated vnc_session would let a
// remote party open an outbound VNC bridge). Callers hand it a `sendFrame`
// (to reply to the office) and a `log`.
// ---------------------------------------------------------------------------

export class VncSessionManager {
  private _sessions: Map<string, VncSession> = new Map();
  private _password: string | undefined;
  private _enabled = false;

  constructor(
    private readonly sendFrame: (frame: Record<string, unknown>) => void,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Enable/disable VNC. Session-start frames are ignored while disabled. */
  setEnabled(enabled: boolean): void { this._enabled = enabled; }

  /** Update the VNC password used for incoming vnc_session requests. */
  setPassword(password?: string): void { this._password = password; }

  /**
   * Dispatch a VNC control frame. Returns true if `msgType` was a VNC frame
   * (and was consumed), false otherwise so the caller can keep matching.
   */
  handleFrame(msgType: string, msg: Record<string, unknown>): boolean {
    switch (msgType) {
      case 'vnc_session': this._onSession(msg); return true;
      case 'vnc_input':   this._onInput(msg);   return true;
      case 'vnc_close':   this._onClose(msg);   return true;
      default: return false;
    }
  }

  private _onSession(msg: Record<string, unknown>): void {
    if (!this._enabled) { this.log('vnc_session ignored — VNC not enabled'); return; }
    const action = msg['action'] as string | undefined;
    if (action !== 'start') { return; }

    const sessionId = msg['sessionId'] as string;
    const port      = Number(msg['port'] ?? 5900);
    // Prefer password from server frame; fall back to locally-configured password
    const password  = (msg['password'] as string | undefined) || this._password;
    this.log(`VNC session start: ${sessionId} → port ${port}`);

    const session = new VncSession(sessionId, (frame) => { this.sendFrame(frame); return true; });
    this._sessions.set(sessionId, session);

    session.start(port, password).catch((err: Error) => {
      this.log(`VNC session ${sessionId} failed to start: ${err.message}`);
      this._sessions.delete(sessionId);
      this.sendFrame({ type: 'vnc_close', sessionId, reason: err.message });
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
      this.log(`VNC session closed: ${sessionId}`);
      this._sessions.get(sessionId)?.stop();
      this._sessions.delete(sessionId);
    }
  }

  /** Stop all active VNC sessions (called on destroy/reconnect). */
  stopAll(): void {
    for (const [id, session] of this._sessions) {
      this.log(`VNC session terminated (disconnect): ${id}`);
      session.stop();
    }
    this._sessions.clear();
  }
}
