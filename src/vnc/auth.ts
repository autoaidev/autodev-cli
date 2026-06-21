/**
 * RFB authentication algorithms.
 *
 * Supported security types:
 *   1  — None (no auth required)
 *   2  — VNC Authentication (DES challenge-response)
 *  18  — TLS (opportunistic — we accept the server cert without validation;
 *              used as a wrapper; inner auth type negotiated separately)
 *  19  — VeNCrypt (TLS variants; we handle plain + VNC sub-types)
 *
 * RFB 3.3 only ever sends a single auth type as a 4-byte uint.
 * RFB 3.7 / 3.8 send a length-prefixed list; the client picks one.
 */

import { desEncrypt } from './des';
import * as tls from 'tls';
import * as net from 'net';

// ── Security type constants ────────────────────────────────────────────────

export const AUTH_NONE          = 1;
export const AUTH_VNC           = 2;
export const AUTH_TIGHT         = 16;
export const AUTH_VENCRYPT      = 19;

// VeNCrypt sub-types we support (plain TCP variants only — no TLS cert)
export const VENCRYPT_PLAIN     = 256; // plain username+password
export const VENCRYPT_TLSNONE   = 257; // TLS with no inner auth
export const VENCRYPT_TLSVNC    = 258; // TLS + VNC auth
export const VENCRYPT_TLSPLAIN  = 259; // TLS + plain auth
export const VENCRYPT_X509NONE  = 260; // X.509 TLS with no inner auth
export const VENCRYPT_X509VNC   = 261; // X.509 TLS + VNC auth
export const VENCRYPT_X509PLAIN = 262; // X.509 TLS + plain auth

// ── Helpers ────────────────────────────────────────────────────────────────

function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) { r = (r << 1) | (b & 1); b >>= 1; }
  return r;
}

/**
 * VNC challenge-response: DES-encrypt the 16-byte challenge with the
 * bit-reversed password key.
 */
export function vncDesResponse(challenge: Buffer, password: string): Buffer {
  const pw  = password.padEnd(8, '\0').slice(0, 8);
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(pw.charCodeAt(i));
  const result = Buffer.alloc(16);
  desEncrypt(challenge.slice(0, 8), key).copy(result, 0);
  desEncrypt(challenge.slice(8, 16), key).copy(result, 8);
  return result;
}

// ── Auth negotiation helpers used by VncBridge ─────────────────────────────

/**
 * Sorted list of auth types we can handle, in preference order.
 * The bridge uses this when negotiating RFB 3.7/3.8 security type lists.
 */
export const SUPPORTED_AUTH_TYPES = [AUTH_NONE, AUTH_VNC, AUTH_VENCRYPT];

/**
 * Pick the best supported auth type from a server-provided list.
 * Returns undefined if none are supported.
 */
export function pickAuthType(serverTypes: number[]): number | undefined {
  for (const preferred of SUPPORTED_AUTH_TYPES) {
    if (serverTypes.includes(preferred)) return preferred;
  }
  return undefined;
}

// ── VeNCrypt negotiation ───────────────────────────────────────────────────

/** VeNCrypt sub-types we can handle, in preference order. */
const SUPPORTED_VENCRYPT_SUBTYPES = [
  VENCRYPT_TLSNONE,
  VENCRYPT_TLSVNC,
  VENCRYPT_TLSPLAIN,
  VENCRYPT_X509NONE,
  VENCRYPT_X509VNC,
  VENCRYPT_X509PLAIN,
  VENCRYPT_PLAIN,
];

/**
 * Negotiate VeNCrypt on a raw socket.  On success, returns the upgraded stream
 * (plain socket or TLS socket) plus the chosen sub-type so the caller knows
 * which inner auth to perform next.
 *
 * Throws on failure.
 */
export async function negotiateVeNCrypt(
  sock: net.Socket,
  readBytes: (n: number) => Promise<Buffer>,
  password: string | undefined,
  username: string | undefined,
): Promise<{ stream: net.Socket | tls.TLSSocket; subType: number }> {
  // Send VeNCrypt version 0.2
  sock.write(Buffer.from([0, 2]));

  const serverVer = await readBytes(2);
  if (serverVer[0] !== 0 || serverVer[1] !== 2) {
    throw new Error(`Unsupported VeNCrypt version: ${serverVer[0]}.${serverVer[1]}`);
  }
  // ACK version
  sock.write(Buffer.from([0]));

  // Read sub-type list
  const countBuf = await readBytes(1);
  const count    = countBuf[0];
  const typesBuf = await readBytes(count * 4);
  const serverSubTypes: number[] = [];
  for (let i = 0; i < count; i++) serverSubTypes.push(typesBuf.readUInt32BE(i * 4));

  const chosen = SUPPORTED_VENCRYPT_SUBTYPES.find(t => serverSubTypes.includes(t));
  if (!chosen) {
    throw new Error(`No supported VeNCrypt sub-type (server offers: ${serverSubTypes.join(', ')})`);
  }

  // Send chosen sub-type
  const choiceBuf = Buffer.alloc(4);
  choiceBuf.writeUInt32BE(chosen, 0);
  sock.write(choiceBuf);

  // Server ACK (1 byte, must be 1)
  const ack = await readBytes(1);
  if (ack[0] !== 1) throw new Error('VeNCrypt: server rejected sub-type selection');

  // ── Upgrade to TLS if needed ─────────────────────────────────────────────
  let stream: net.Socket | tls.TLSSocket = sock;
  if (chosen !== VENCRYPT_PLAIN) {
    stream = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSock = tls.connect({
        socket:             sock,
        rejectUnauthorized: false, // VNC servers use self-signed certs
      });
      tlsSock.once('secureConnect', () => resolve(tlsSock));
      tlsSock.once('error',         (e) => reject(e));
    });
  }

  // ── Inner auth ───────────────────────────────────────────────────────────
  if (chosen === VENCRYPT_PLAIN || chosen === VENCRYPT_TLSPLAIN || chosen === VENCRYPT_X509PLAIN) {
    if (!username || !password) throw new Error('VeNCrypt plain auth requires username and password');
    const userBuf = Buffer.from(username, 'utf8');
    const passBuf = Buffer.from(password, 'utf8');
    const lenBuf  = Buffer.alloc(8);
    lenBuf.writeUInt32BE(userBuf.length, 0);
    lenBuf.writeUInt32BE(passBuf.length, 4);
    (stream as net.Socket).write(Buffer.concat([lenBuf, userBuf, passBuf]));
  }
  // TLSNONE / X509NONE: no inner auth data to send
  // TLSVNC  / X509VNC : VNC challenge-response is handled by bridge after this returns

  return { stream, subType: chosen };
}
