/**
 * RdpAuth — handles the security negotiation layer for RDP connections.
 *
 * Supported protocols (negotiated via X.224 Negotiation Request):
 *   PROTOCOL_RDP    (0) — Classic RDP Security (RC4); rarely used today
 *   PROTOCOL_SSL    (1) — TLS wrapping (most XRDP servers)
 *   PROTOCOL_HYBRID (2) — CredSSP / NLA (Windows default; Phase 2)
 *
 * For Phase 1 (XRDP / local targets) we negotiate TLS-only (PROTOCOL_SSL).
 * This avoids the full CredSSP/NTLM stack and works against:
 *   - xrdp with TLS enabled  (default on modern Linux)
 *   - Windows 2008+ with "Allow connections from … any version" security level
 *
 * NLA (CredSSP) is prepared as a future phase — see negotiateNla().
 */

import * as net from 'net';
import * as tls from 'tls';
import { PROTOCOL_SSL, PROTOCOL_RDP, X224_TPDU_CONNECTION_REQUEST, X224_TPDU_CONNECTION_CONFIRM } from './constants';

// ── X.224 helpers ──────────────────────────────────────────────────────────

/**
 * Build an X.224 Connection Request TPDU with an RDP Negotiation Request
 * appended as a type-length-value (TLV) trailer.
 *
 * The cookie (mstshash=<username>) is optional but recommended for xrdp
 * load-balancing.
 */
export function buildX224ConnectRequest(
  requestedProtocols: number,
  username?: string,
): Buffer {
  const cookie = username
    ? `Cookie: mstshash=${username}\r\n`
    : '';

  // RDP Negotiation Request TLV: type(1) + flags(1) + length(2) + protocols(4)
  const negReq = Buffer.alloc(8);
  negReq[0] = 0x01;            // TYPE_RDP_NEG_REQ
  negReq[1] = 0x00;            // flags
  negReq.writeUInt16LE(0x0008, 2); // length = 8
  negReq.writeUInt32LE(requestedProtocols, 4);

  // TPDU variable part: cookie + negotiation request
  const varPart = Buffer.concat([
    Buffer.from(cookie, 'ascii'),
    negReq,
  ]);

  // X.224 CR TPDU header: LI(1) + code(1) + dstRef(2) + srcRef(2) + class(1)
  const li   = 6 + varPart.length; // header length indicator (bytes after LI itself)
  const tpdu = Buffer.alloc(7 + varPart.length);
  tpdu[0] = li;
  tpdu[1] = X224_TPDU_CONNECTION_REQUEST;
  tpdu.writeUInt16BE(0x0000, 2); // dst ref
  tpdu.writeUInt16BE(0x0000, 4); // src ref
  tpdu[6] = 0x00;               // class 0
  varPart.copy(tpdu, 7);

  // TPKT header: version(1) + reserved(1) + length(2)
  const totalLen = 4 + tpdu.length;
  const tpkt = Buffer.alloc(4 + tpdu.length);
  tpkt[0] = 0x03; // TPKT version
  tpkt[1] = 0x00; // reserved
  tpkt.writeUInt16BE(totalLen, 2);
  tpdu.copy(tpkt, 4);

  return tpkt;
}

/**
 * Parse the X.224 Connection Confirm TPDU (and optional Negotiation Response).
 * Returns the selected protocol or throws on failure.
 */
export function parseX224ConnectConfirm(data: Buffer): number {
  if (data.length < 7) throw new Error('X.224 CC too short');
  if (data[0] !== 0x03) throw new Error('Not a TPKT packet');

  const tpduStart = 4;
  const code = data[tpduStart + 1];
  if (code !== X224_TPDU_CONNECTION_CONFIRM) {
    throw new Error(`Expected X.224 CC (0xD0), got 0x${code.toString(16)}`);
  }

  // Check for optional RDP Negotiation TLV appended after the fixed 7-byte header
  const varOffset = tpduStart + 7;
  if (data.length >= varOffset + 8) {
    const tlvType = data[varOffset];

    if (tlvType === 0x02) {
      // TYPE_RDP_NEG_RSP — server accepted our requested protocol.
      // The flags field here contains capability bits (e.g. EXTENDED_CLIENT_DATA_SUPPORTED=0x01)
      // which are NOT error indicators — do not treat them as failures.
      return data.readUInt32LE(varOffset + 4);
    }

    if (tlvType === 0x03) {
      // TYPE_RDP_NEG_FAILURE — server rejected our protocol request.
      const failureCode = data.readUInt32LE(varOffset + 4);
      const reasons: Record<number, string> = {
        1: 'SSL_REQUIRED_BY_SERVER',
        2: 'SSL_NOT_ALLOWED_BY_SERVER',
        3: 'SSL_CERT_NOT_ON_SERVER',
        4: 'INCONSISTENT_FLAGS',
        5: 'HYBRID_REQUIRED_BY_SERVER (NLA required)',
        6: 'SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER',
      };
      throw new Error(`RDP Negotiation Failure: ${reasons[failureCode] ?? `code ${failureCode}`}`);
    }
  }

  // No negotiation TLV — server accepted default (classic RDP security)
  return PROTOCOL_RDP;
}

// ── TLS upgrade ───────────────────────────────────────────────────────────

/**
 * Upgrade a plain TCP socket to TLS.
 * Returns the TLS socket once the handshake is complete.
 * Certificate validation is disabled (self-signed is the norm for RDP).
 */
export function upgradeTls(
  sock: net.Socket,
  host: string,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({
      socket: sock,
      host,
      rejectUnauthorized: false, // RDP servers use self-signed certs
    });
    tlsSock.once('secureConnect', () => resolve(tlsSock));
    tlsSock.once('error', reject);
  });
}

// ── RDP Security (Classic — no longer recommended but kept for completeness) ─

/**
 * Generate a 32-byte random client random for Classic RDP Security.
 * Not used in TLS mode but exposed for completeness / future use.
 */
export function generateClientRandom(): Buffer {
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.randomBytes(32);
}

// ── NLA / CredSSP stub (Phase 2) ──────────────────────────────────────────

/**
 * Placeholder for CredSSP / NLA negotiation.
 * Full NTLM + CredSSP is complex; this throws with a clear message so callers
 * can detect that NLA is required and surface a useful error to the user.
 *
 * @throws Always — NLA is not yet implemented.
 */
export function negotiateNla(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _sock: tls.TLSSocket,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _username: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _password: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _domain: string,
): Promise<void> {
  return Promise.reject(
    new Error(
      'NLA / CredSSP authentication is not yet supported. ' +
      'Connect to an RDP server configured for SSL/TLS security level, ' +
      'or use xrdp with TLS enabled.',
    ),
  );
}

// ── Protocol selection helper ─────────────────────────────────────────────

/**
 * Choose the best protocol to request during X.224 negotiation.
 * We always try TLS first; fall back to classic RDP only if the server
 * explicitly rejects and the caller retries.
 */
export function selectRequestProtocol(): number {
  return PROTOCOL_SSL;
}
