/**
 * RdpBridge — TCP/TLS connection to an RDP server.
 *
 * Implements the minimal RDP protocol phases needed for screen + input:
 *
 *   Phase 1  X.224 Connection Request / Confirm  (TPKT/X.224)
 *   Phase 2  TLS upgrade  (PROTOCOL_SSL negotiated in Phase 1)
 *   Phase 3  MCS Connect  (T.125 / GCC Conference Create)
 *   Phase 4  MCS Erect Domain + Attach User
 *   Phase 5  MCS Channel Joins  (Global + optional cliprdr)
 *   Phase 6  RDP Security Exchange + Client Info  (Classic RDP Security disabled; TLS carries everything)
 *   Phase 7  Demand-Active / Confirm-Active capability exchange
 *   Phase 8  Running — bitmap updates, input events, clipboard
 *
 * Emits:
 *   'fbu'       (rects: RdpRect[])               — one or more bitmap rectangles
 *   'cursor'    ({ hotX, hotY, width, height, rgba: string }) — cursor shape update
 *   'clipboard' (text: string)                   — remote clipboard changed
 *   'error'     (err: Error)                     — unrecoverable error
 *   'close'     ()                               — TCP/TLS connection closed
 */

import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  buildX224ConnectRequest,
  parseX224ConnectConfirm,
  upgradeTls,
  selectRequestProtocol,
} from './auth';
import {
  RDP_DEFAULT_PORT,
  RDP_DEFAULT_WIDTH,
  RDP_DEFAULT_HEIGHT,
  RDP_DEFAULT_COLOR_DEPTH,
  X224_TPDU_DATA,
  MCS_ERECT_DOMAIN_REQUEST,
  MCS_ATTACH_USER_REQUEST,
  MCS_ATTACH_USER_CONFIRM,
  MCS_CHANNEL_JOIN_REQUEST,
  MCS_CHANNEL_JOIN_CONFIRM,
  MCS_SEND_DATA_REQUEST,
  MCS_SEND_DATA_INDICATION,
  MCS_CHANNEL_GLOBAL,
  PDUTYPE_DEMANDACTIVEPDU,
  PDUTYPE_CONFIRMACTIVEPDU,
  PDUTYPE_DATAPDU,
  PDUTYPE2_UPDATE,
  PDUTYPE2_SYNCHRONIZE,
  PDUTYPE2_CONTROL,
  PDUTYPE2_FONTLIST,
  PDUTYPE2_FONTMAP,
  PDUTYPE2_INPUT,
  PDUTYPE2_REFRESH_RECT,
  PDUTYPE2_SUPPRESS_OUTPUT,
  UPDATE_BITMAP,
  SEC_LOGON_INFO,
  BITMAP_COMPRESSION,
  NO_BITMAP_COMPRESSION_HDR,
  INPUT_EVENT_SCANCODE,
  INPUT_EVENT_MOUSE,
  INPUT_EVENT_SYNC,
  KBDFLAGS_RELEASE,
  KBDFLAGS_EXTENDED,
  PTRFLAGS_MOVE,
  PTRFLAGS_DOWN,
  PTRFLAGS_BUTTON1,
  PTRFLAGS_BUTTON2,
  PTRFLAGS_BUTTON3,
  ENCRYPTION_METHOD_NONE,
  ENCRYPTION_LEVEL_NONE,
  RDP_SCANCODE,
  RDP_EXTENDED_KEYS,
} from './constants';
import type { RdpInfo, RdpRect, RdpConnectOptions } from './types';

// ── TPKT helpers ───────────────────────────────────────────────────────────

function wrapTpkt(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0x03; // TPKT version
  out[1] = 0x00;
  out.writeUInt16BE(4 + payload.length, 2);
  payload.copy(out, 4);
  return out;
}

function wrapX224Data(payload: Buffer): Buffer {
  // X.224 Data TPDU: LI(1)=2, code(1)=0xF0, EOT(1)=0x80
  const header = Buffer.from([0x02, X224_TPDU_DATA, 0x80]);
  return Buffer.concat([header, payload]);
}

function wrapMcsSend(userId: number, channelId: number, payload: Buffer): Buffer {
  // MCS SendDataRequest BER encoding (simplified):
  // opcode(1) | initiator(2) | channelId(2) | dataPriority+segmentation(1) | length(variable) | data
  const dataLen = payload.length;
  let lenBuf: Buffer;
  if (dataLen < 128) {
    lenBuf = Buffer.from([dataLen]);
  } else if (dataLen < 0x4000) {
    lenBuf = Buffer.from([0x80 | (dataLen >> 8), dataLen & 0xff]);
  } else {
    lenBuf = Buffer.from([0x82, (dataLen >> 16) & 0xff, (dataLen >> 8) & 0xff, dataLen & 0xff]);
  }
  const header = Buffer.alloc(6);
  header[0] = MCS_SEND_DATA_REQUEST;
  header.writeUInt16BE(userId - 1001, 1);  // initiator (offset from base)
  header.writeUInt16BE(channelId, 3);
  header[5] = 0x70; // high priority + end of segmentation
  return Buffer.concat([header, lenBuf, payload]);
}

// ── GCC / MCS Connect helpers ─────────────────────────────────────────────

/** Encode a BER length field. */
function berLen(len: number): Buffer {
  if (len < 128)   return Buffer.from([len]);
  if (len < 256)   return Buffer.from([0x81, len]);
  return Buffer.from([0x82, len >> 8, len & 0xff]);
}

/** Wrap `content` in a BER TLV.  `tag` may be 1 or 2 bytes (e.g. 0x7f65). */
function berTlv(tag: number, content: Buffer): Buffer {
  const tagBuf = tag > 0xff
    ? Buffer.from([tag >> 8, tag & 0xff])
    : Buffer.from([tag]);
  return Buffer.concat([tagBuf, berLen(content.length), content]);
}

/** BER-encode a small non-negative INTEGER. */
function berInt(v: number): Buffer {
  if (v === 0)        return Buffer.from([0x02, 0x01, 0x00]);
  if (v <= 0x7f)      return Buffer.from([0x02, 0x01, v]);
  if (v <= 0x7fff)    return Buffer.from([0x02, 0x02, v >> 8, v & 0xff]);
  return Buffer.from([0x02, 0x03, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}

/** Build one MCS DomainParameters SEQUENCE. */
function berDomainParams(
  maxChannelIds: number, maxUserIds: number, maxTokenIds: number,
  numPriorities: number, minThroughput: number, maxHeight: number,
  maxMCSPDU: number,     protocolVersion: number,
): Buffer {
  const body = Buffer.concat([
    berInt(maxChannelIds), berInt(maxUserIds),    berInt(maxTokenIds),
    berInt(numPriorities), berInt(minThroughput), berInt(maxHeight),
    berInt(maxMCSPDU),     berInt(protocolVersion),
  ]);
  return berTlv(0x30, body); // SEQUENCE
}

function buildMcsConnectInitial(
  width: number,
  height: number,
  colorDepth: number,
): Buffer {
  // ── GCC Conference Create Request (client core data only) ─────────────────
  // Full spec: [MS-RDPBCGR] section 2.2.1.3

  const rdpVersion = 0x00080004; // RDP 5.0+

  // Client Core Data (CS_CORE): type=0xC001, length=216 bytes
  const csCore = Buffer.alloc(216);
  csCore.writeUInt16LE(0xC001, 0); // CS_CORE
  csCore.writeUInt16LE(216, 2);    // length
  csCore.writeUInt32LE(rdpVersion, 4);
  csCore.writeUInt16LE(width, 8);
  csCore.writeUInt16LE(height, 10);
  csCore.writeUInt16LE(0xCA01, 12); // colorDepth = 8bpp (negotiated later)
  csCore.writeUInt16LE(0xAA03, 14); // SASSequence
  csCore.writeUInt32LE(0x0409, 16); // keyboardLayout (English US)
  csCore.writeUInt32LE(2600, 20);   // clientBuild
  Buffer.from('autodev', 'utf16le').copy(csCore, 24); // clientName (32 bytes)
  csCore.writeUInt32LE(0x00000004, 56); // keyboardType = IBM enhanced
  csCore.writeUInt32LE(0x00000000, 60); // keyboardSubType
  csCore.writeUInt32LE(12, 64);         // keyboardFunctionKey
  csCore.writeUInt16LE(0xCA01, 130); // postBeta2ColorDepth
  csCore.writeUInt16LE(1, 132);      // clientProductId
  csCore.writeUInt32LE(0, 134);      // serialNumber
  const hcd = colorDepth >= 24 ? 24 : colorDepth >= 16 ? 16 : colorDepth >= 15 ? 15 : 8;
  csCore.writeUInt16LE(hcd, 138);
  csCore.writeUInt16LE(0x0007, 140); // supportedColorDepths: 15|16|24bpp
  csCore.writeUInt16LE(0x0001, 142); // earlyCapabilityFlags: ERRINFO_PDU
  csCore.writeUInt8(0, 208);         // connectionType
  csCore.writeUInt8(0, 209);         // pad1Octet
  csCore.writeUInt32LE(0x00000001 /* PROTOCOL_SSL */, 210); // serverSelectedProtocol

  // Client Security Data (CS_SECURITY): no encryption
  const csSec = Buffer.alloc(12);
  csSec.writeUInt16LE(0xC002, 0);
  csSec.writeUInt16LE(12, 2);
  csSec.writeUInt32LE(ENCRYPTION_METHOD_NONE, 4);
  csSec.writeUInt32LE(ENCRYPTION_LEVEL_NONE, 8);

  // Client Cluster Data (CS_CLUSTER)
  const csCluster = Buffer.alloc(12);
  csCluster.writeUInt16LE(0xC004, 0);
  csCluster.writeUInt16LE(12, 2);
  csCluster.writeUInt32LE(0x0000000D, 4); // REDIRECTION_SUPPORTED
  csCluster.writeUInt32LE(0, 8);

  const clientData = Buffer.concat([csCore, csSec, csCluster]);

  // GCC ConferenceCreateRequest — T.124 PER-encoded wrapper
  // [MS-RDPBCGR] 2.2.1.3 — the ConnectGCCPDU body must carry the proper
  // T.124 ConferenceCreateRequest structure before the H.221/Duca client data.
  // Without this structure xrdp cannot extract the screen dimensions and aborts
  // with "xrdp_bitmap_create: size overflow 0x0x4" after the FontMap handshake.
  function perLen(len: number): Buffer {
    // PER unconstrained length: 1 byte for 0-127, 2 bytes for 128-16383
    if (len <= 0x7F) return Buffer.from([len]);
    return Buffer.from([0x80 | (len >> 8), len & 0xFF]);
  }
  // ConnectGCCPDU body: choice(1) + conference-name(5) + optFlags(2) + "Duca"(4)
  //                   + perLen(clientData) + clientData
  const ccrBody = Buffer.concat([
    Buffer.from([
      0x00,                         // choice: conferenceCreateRequest
      0x08, 0x00, 0x10, 0x00, 0x01, // conference name PER
      0xC0, 0x00,                   // optional fields: userData present
      0x44, 0x75, 0x63, 0x61,       // H.221 non-standard key "Duca"
    ]),
    perLen(clientData.length),      // PER length of client data blocks
    clientData,
  ]);
  // T.124 ConnectData: H.221 OID key + PER length of CCR body + CCR body
  const gccKey = Buffer.from([0x00, 0x05, 0x00, 0x14, 0x7c, 0x00, 0x01]);
  const gccConnReq = Buffer.concat([gccKey, perLen(ccrBody.length), ccrBody]);

  // MCS Connect-Initial BER encoding  [MS-RDPBCGR] 2.2.1.3 / T.125
  //
  // ConnectInitial ::= [APPLICATION 101] IMPLICIT SEQUENCE {
  //   callingDomainSelector  OCTET STRING,
  //   calledDomainSelector   OCTET STRING,
  //   upwardFlag             BOOLEAN,
  //   targetParameters       DomainParameters,
  //   minimumParameters      DomainParameters,
  //   maximumParameters      DomainParameters,
  //   userData               OCTET STRING        ← contains GCC data
  // }
  const body = Buffer.concat([
    berTlv(0x04, Buffer.from([0x01])),          // callingDomainSelector
    berTlv(0x04, Buffer.from([0x01])),          // calledDomainSelector
    Buffer.from([0x01, 0x01, 0xff]),            // upwardFlag BOOLEAN TRUE
    berDomainParams(34,    2,    0, 1, 0, 1, 65535, 2),  // target
    berDomainParams(1,     1,    1, 1, 0, 1,  1056, 2),  // minimum
    berDomainParams(65535, 64535, 65535, 1, 0, 1, 65535, 2), // maximum
    berTlv(0x04, gccConnReq),                   // userData
  ]);

  // Wrap in APPLICATION 101 CONSTRUCTED = 0x7f 0x65
  return berTlv(0x7f65, body);
}

// ── License crypto helpers ────────────────────────────────────────────────

/** Modular exponentiation using BigInt (for pure-JS RSA). */
function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * RSA PKCS#1 v1.5 encrypt `message` using an RDP little-endian modulus.
 * Returns the ciphertext in little-endian (as RDP expects).
 */
function rsaEncryptLe(message: Buffer, modulusLe: Buffer, exponent: number): Buffer {
  const modulusBe = Buffer.from(modulusLe).reverse();
  const n = BigInt('0x' + modulusBe.toString('hex'));
  const ks = modulusLe.length;
  const padLen = ks - message.length - 3;
  const padBytes = crypto.randomBytes(padLen).map(b => b === 0 ? 1 : b);
  const padded = Buffer.concat([Buffer.from([0x00, 0x02]), padBytes, Buffer.from([0x00]), message]);
  const m = BigInt('0x' + padded.toString('hex'));
  const c = modpow(m, BigInt(exponent), n);
  const cHex = c.toString(16).padStart(ks * 2, '0');
  return Buffer.from(Buffer.from(cHex, 'hex')).reverse(); // LE
}

/** MS-RDPELE §5.1.3 salted hash: SHA1 + MD5 mix. */
function saltedHash(secret: Buffer, label: Buffer, r1: Buffer, r2: Buffer): Buffer {
  const sha = crypto.createHash('sha1');
  sha.update(label); sha.update(secret); sha.update(r1); sha.update(r2);
  const md5 = crypto.createHash('md5');
  md5.update(secret); md5.update(sha.digest());
  return md5.digest();
}

/** Derive MAC key (16 B) and enc key (16 B) from pre-master secret. */
function deriveLicenseKeys(
  preMaster: Buffer, clientRand: Buffer, serverRand: Buffer,
): [Buffer, Buffer] {
  let ms = Buffer.concat([
    saltedHash(preMaster, Buffer.from('A'),   clientRand, serverRand),
    saltedHash(preMaster, Buffer.from('BB'),  clientRand, serverRand),
    saltedHash(preMaster, Buffer.from('CCC'), clientRand, serverRand),
  ]);
  const skb = Buffer.concat([
    saltedHash(ms, Buffer.from('A'),   serverRand, clientRand),
    saltedHash(ms, Buffer.from('BB'),  serverRand, clientRand),
    saltedHash(ms, Buffer.from('CCC'), serverRand, clientRand),
  ]);
  return [skb.slice(0, 16), skb.slice(16, 32)]; // [mac_key, enc_key]
}

function macData(macKey: Buffer, data: Buffer): Buffer {
  const p1 = Buffer.alloc(40).fill(0x36);
  const p2 = Buffer.alloc(48).fill(0x5c);
  const sha = crypto.createHash('sha1');
  sha.update(macKey); sha.update(p1);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(data.length, 0);
  sha.update(lenBuf); sha.update(data);
  const md5 = crypto.createHash('md5');
  md5.update(macKey); md5.update(p2); md5.update(sha.digest());
  return md5.digest().slice(0, 16);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const cipher = crypto.createDecipheriv('rc4' as any, key, null as any);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Parse SERVER_LICENSE_REQUEST to extract serverRandom, RSA modulus (LE) and exponent.
 * `body` starts at the license preamble (4 bytes before ServerRandom).
 */
function parseLicenseRequest(body: Buffer): { serverRand: Buffer; modulusLe: Buffer; exponent: number } {
  // body[0..3] = preamble; body[4..35] = ServerRandom[32]
  const serverRand = body.slice(4, 36);
  let pos = 36;
  // ProductInfo: dwVersion(4) + cbCompanyName(4) + name + cbProductId(4) + id
  const cbCompany = body.readUInt32LE(pos + 4);
  pos += 4 + 4 + cbCompany;
  const cbProduct = body.readUInt32LE(pos);
  pos += 4 + cbProduct;
  // KeyExchangeList blob: wBlobType(2)+wBlobLen(2)+data
  const kbLen = body.readUInt16LE(pos + 2); pos += 4 + kbLen;
  // ServerCertificate blob
  const certLen = body.readUInt16LE(pos + 2);
  const cert = body.slice(pos + 4, pos + 4 + certLen);
  // PROPRIETARYSERVERCERTIFICATE: dwVersion(4)+dwSigAlgId(4)+dwKeyAlgId(4)+wBlobType(2)+wBlobLen(2)+RSA_PUBLIC_KEY
  const pkBlobLen = cert.readUInt16LE(14);
  const pk = cert.slice(16, 16 + pkBlobLen); // RSA_PUBLIC_KEY
  // RSA1(4)+keylen(4)+bitlen(4)+datalen(4)+pubExp(4)+modulus(keylen)
  const keylen   = pk.readUInt32LE(4);
  const bitlen   = pk.readUInt32LE(8);
  const exponent = pk.readUInt32LE(16);
  const modulusLe = pk.slice(20, 20 + bitlen / 8);
  return { serverRand, modulusLe, exponent };
}

function buildNewLicenseRequest(
  clientRand: Buffer, encPms: Buffer, username: string, machine: string,
): Buffer {
  const un = Buffer.from(username + '\0', 'ascii');
  const mn = Buffer.from(machine  + '\0', 'ascii');
  const body = Buffer.alloc(4 + 4 + 32 + 4 + encPms.length + 4 + un.length + 4 + mn.length);
  let off = 0;
  body.writeUInt32LE(1, off); off += 4;           // KEY_EXCHANGE_ALG_RSA
  body.writeUInt32LE(0x04000000, off); off += 4;  // PlatformId
  clientRand.copy(body, off); off += 32;
  body.writeUInt16LE(0x0006, off); off += 2;       // wBlobType = BB_KEY_EXCHG_ALG_BLOB
  body.writeUInt16LE(encPms.length, off); off += 2;
  encPms.copy(body, off); off += encPms.length;
  body.writeUInt16LE(0x000f, off); off += 2;       // wBlobType = BB_CLIENT_USER_NAME_BLOB
  body.writeUInt16LE(un.length, off); off += 2;
  un.copy(body, off); off += un.length;
  body.writeUInt16LE(0x0010, off); off += 2;       // wBlobType = BB_CLIENT_MACHINE_NAME_BLOB
  body.writeUInt16LE(mn.length, off); off += 2;
  mn.copy(body, off);
  const preamble = Buffer.alloc(4);
  preamble.writeUInt8(0x13, 0); preamble.writeUInt8(0x00, 1);
  preamble.writeUInt16LE(4 + body.length, 2);
  return Buffer.concat([preamble, body]);
}

function buildPlatformChallengeResponse(
  encKey: Buffer, macKey: Buffer, challengePlain: Buffer,
): Buffer {
  const hwid = Buffer.alloc(8); hwid.writeUInt32LE(2, 0); // hardwareIDVersion=2, hardwareID1=0
  const encChallenge = rc4(encKey, challengePlain);
  const encHwid      = rc4(encKey, hwid);
  const mac          = macData(macKey, Buffer.concat([challengePlain, hwid]));
  const encChalLen = Buffer.alloc(4);
  encChalLen.writeUInt16LE(0x000e, 0); encChalLen.writeUInt16LE(encChallenge.length, 2);
  const encHwidLen = Buffer.alloc(4);
  encHwidLen.writeUInt16LE(0x000f, 0); encHwidLen.writeUInt16LE(encHwid.length, 2);
  const body = Buffer.concat([encChalLen, encChallenge, encHwidLen, encHwid, mac]);
  const preamble = Buffer.alloc(4);
  preamble.writeUInt8(0x15, 0); preamble.writeUInt8(0x80, 1);
  preamble.writeUInt16LE(4 + body.length, 2);
  return Buffer.concat([preamble, body]);
}

// ── Client Info PDU ───────────────────────────────────────────────────────

function buildClientInfoPdu(
  username: string,
  password: string,
  domain: string,
): Buffer {
  // [MS-RDPBCGR] 2.2.1.11  INFO_PACKET
  const INFO_MOUSE         = 0x00000001;
  const INFO_DISABLECTRLALTDEL = 0x00000002;
  const INFO_AUTOLOGON     = 0x00000008;
  const INFO_UNICODE       = 0x00000010;
  const INFO_MAXIMIZESHELL = 0x00000020;
  const INFO_COMPRESSION   = 0x00000080;
  const INFO_ENABLEWINDOWSKEY = 0x00000100;

  const encU = (s: string) => Buffer.from(s + '\0', 'utf16le');
  const domainBuf   = encU(domain);
  const usernameBuf = encU(username);
  const passwordBuf = encU(password);
  const shellBuf    = encU('');
  const workdirBuf  = encU('');

  const flags = INFO_MOUSE | INFO_DISABLECTRLALTDEL | INFO_AUTOLOGON |
                INFO_UNICODE | INFO_MAXIMIZESHELL | INFO_COMPRESSION |
                INFO_ENABLEWINDOWSKEY;

  const hdr = Buffer.alloc(18);
  hdr.writeUInt32LE(0, 0);  // codePage
  hdr.writeUInt32LE(flags, 4);
  hdr.writeUInt16LE(domainBuf.length - 2, 8);   // cbDomain (excluding null)
  hdr.writeUInt16LE(usernameBuf.length - 2, 10); // cbUserName
  hdr.writeUInt16LE(passwordBuf.length - 2, 12); // cbPassword
  hdr.writeUInt16LE(shellBuf.length - 2, 14);    // cbAlternateShell
  hdr.writeUInt16LE(workdirBuf.length - 2, 16);  // cbWorkingDir

  // TS_EXTENDED_INFO_PACKET (required by RDP 5.0+)
  // clientAddressFamily(2) + cbClientAddress(2) + clientAddress(2) +
  // cbClientDir(2) + clientDir(2) + clientTimeZone(172) +
  // clientSessionId(4) + performanceFlags(4) + cbAutoReconnectCookie(2)
  const ext = Buffer.alloc(2 + 2 + 2 + 2 + 2 + 172 + 4 + 4 + 2);
  ext.writeUInt16LE(0x0002, 0);  // clientAddressFamily = AF_INET
  ext.writeUInt16LE(2, 2);       // cbClientAddress = 2 (null-term only)
  // clientAddress[2] = 0x0000 (already zero)
  ext.writeUInt16LE(2, 6);       // cbClientDir = 2 (null-term only)
  // clientDir[2] = 0x0000 (already zero)
  // clientTimeZone[172] = all zeros (UTC)
  // clientSessionId, performanceFlags, cbAutoReconnectCookie = 0

  const info = Buffer.concat([hdr, domainBuf, usernameBuf, passwordBuf, shellBuf, workdirBuf, ext]);

  // Prepend SEC_INFO_PKT Security Header (flags only — no encryption)
  const secHdr = Buffer.alloc(4);
  secHdr.writeUInt16LE(SEC_LOGON_INFO, 0);
  secHdr.writeUInt16LE(0, 2); // flagsHi

  return Buffer.concat([secHdr, info]);
}

// ── RDP Capabilities ──────────────────────────────────────────────────────

function buildConfirmActivePdu(
  userId: number,
  shareId: number,
  width: number,
  height: number,
): Buffer {
  // ShareControlHeader
  const numCaps = 13;

  // Build minimal capability set
  const caps: Buffer[] = [];

  // CAPSTYPE_GENERAL (0x0001)
  const genCap = Buffer.alloc(24);
  genCap.writeUInt16LE(0x0001, 0); genCap.writeUInt16LE(24, 2);
  genCap.writeUInt16LE(1, 4);  // osMajorType = Windows
  genCap.writeUInt16LE(3, 6);  // osMinorType = Windows NT
  genCap.writeUInt16LE(0x0200, 8); // protocolVersion
  genCap.writeUInt16LE(0x0000, 12); // extraFlags: no fast-path (force slow-path TPKT updates)
  genCap.writeUInt16LE(2, 20); // refreshRectSupport
  genCap.writeUInt16LE(2, 22); // suppressOutputSupport
  caps.push(genCap);

  // CAPSTYPE_BITMAP (0x0002)
  const bitmapCap = Buffer.alloc(28);
  bitmapCap.writeUInt16LE(0x0002, 0); bitmapCap.writeUInt16LE(28, 2);
  bitmapCap.writeUInt16LE(24, 4);   // preferredBitsPerPixel
  bitmapCap.writeUInt16LE(1, 6);    // receive1BitPerPixel
  bitmapCap.writeUInt16LE(1, 8);    // receive4BitsPerPixel
  bitmapCap.writeUInt16LE(1, 10);   // receive8BitsPerPixel
  bitmapCap.writeUInt16LE(width, 12);
  bitmapCap.writeUInt16LE(height, 14);
  bitmapCap.writeUInt16LE(0, 16);   // pad
  bitmapCap.writeUInt16LE(1, 18);   // desktopResizeFlag
  bitmapCap.writeUInt16LE(1, 20);   // bitmapCompressionFlag
  bitmapCap.writeUInt8(0, 22);      // highColorFlags
  bitmapCap.writeUInt8(0, 23);      // drawingFlags
  bitmapCap.writeUInt16LE(1, 24);   // multipleRectangleSupport
  bitmapCap.writeUInt16LE(0, 26);   // pad
  caps.push(bitmapCap);

  // CAPSTYPE_ORDER (0x0003) — minimal, no complex orders
  const orderCap = Buffer.alloc(88);
  orderCap.writeUInt16LE(0x0003, 0); orderCap.writeUInt16LE(88, 2);
  // terminalDescriptor: 16 bytes (zero)
  orderCap.writeUInt32LE(0, 20); // pad4OctetsA
  orderCap.writeUInt16LE(1, 24); // desktopSaveXGranularity
  orderCap.writeUInt16LE(20, 26); // desktopSaveYGranularity
  orderCap.writeUInt16LE(0, 28); // pad2OctetsA
  orderCap.writeUInt16LE(1, 30); // maximumOrderLevel
  orderCap.writeUInt16LE(0, 32); // numberFonts
  orderCap.writeUInt16LE(0x0022, 34); // orderFlags: NEGOTIATEORDERSUPPORT | ZEROBOUNDSDELTASSUPPORT
  // orderSupport: 32 bytes (all zero — no drawing orders)
  orderCap.writeUInt16LE(0, 68); // textFlags
  orderCap.writeUInt16LE(0, 70); // orderSupportExFlags
  orderCap.writeUInt32LE(0, 72); // pad4OctetsB
  orderCap.writeUInt32LE(230400, 76); // desktopSaveSize
  orderCap.writeUInt16LE(0, 80); // pad2OctetsC
  orderCap.writeUInt16LE(0, 82); // pad2OctetsD
  orderCap.writeUInt16LE(0x006e, 84); // textANSICodePage
  orderCap.writeUInt16LE(0, 86); // pad2OctetsE
  caps.push(orderCap);

  // CAPSTYPE_INPUT (0x000d)
  const inputCap = Buffer.alloc(88);
  inputCap.writeUInt16LE(0x000d, 0); inputCap.writeUInt16LE(88, 2);
  inputCap.writeUInt16LE(0x0001 | 0x0004 | 0x0020, 4); // INPUT_FLAG_SCANCODES | MOUSEX | UNICODE
  inputCap.writeUInt16LE(0, 6);     // pad
  inputCap.writeUInt32LE(0x0409, 8); // keyboardLayout
  inputCap.writeUInt32LE(4, 12);    // keyboardType
  inputCap.writeUInt32LE(0, 16);    // keyboardSubType
  inputCap.writeUInt32LE(12, 20);   // keyboardFunctionKey
  caps.push(inputCap);

  // CAPSTYPE_POINTER (0x0008)
  const ptrCap = Buffer.alloc(10);
  ptrCap.writeUInt16LE(0x0008, 0); ptrCap.writeUInt16LE(10, 2);
  ptrCap.writeUInt16LE(0, 4);  // colorPointerFlag
  ptrCap.writeUInt16LE(20, 6); // colorPointerCacheSize
  ptrCap.writeUInt16LE(21, 8); // pointerCacheSize
  caps.push(ptrCap);

  // CAPSTYPE_SHARE (0x0009)
  const shareCap = Buffer.alloc(8);
  shareCap.writeUInt16LE(0x0009, 0); shareCap.writeUInt16LE(8, 2);
  shareCap.writeUInt16LE(0, 4); // nodeId (client = 0)
  shareCap.writeUInt16LE(0, 6); // pad
  caps.push(shareCap);

  // CAPSTYPE_COLORCACHE (0x000a)
  const ccCap = Buffer.alloc(8);
  ccCap.writeUInt16LE(0x000a, 0); ccCap.writeUInt16LE(8, 2);
  ccCap.writeUInt16LE(6, 4);
  ccCap.writeUInt16LE(0, 6);
  caps.push(ccCap);

  // CAPSTYPE_CONTROL (0x0005)
  const ctrlCap = Buffer.alloc(12);
  ctrlCap.writeUInt16LE(0x0005, 0); ctrlCap.writeUInt16LE(12, 2);
  caps.push(ctrlCap);

  // CAPSTYPE_ACTIVATION (0x0007)
  const actCap = Buffer.alloc(12);
  actCap.writeUInt16LE(0x0007, 0); actCap.writeUInt16LE(12, 2);
  caps.push(actCap);

  // CAPSTYPE_FONT (0x000e)
  const fontCap = Buffer.alloc(8);
  fontCap.writeUInt16LE(0x000e, 0); fontCap.writeUInt16LE(8, 2);
  fontCap.writeUInt16LE(1, 4); // fontSupportFlags: FONTSUPPORT_FONTLIST
  caps.push(fontCap);

  // CAPSTYPE_BITMAPCACHE (0x0004)
  const bmpCache = Buffer.alloc(40);
  bmpCache.writeUInt16LE(0x0004, 0); bmpCache.writeUInt16LE(40, 2);
  caps.push(bmpCache);

  // CAPSTYPE_BRUSHSUPPORT (0x000f)
  const brushCap = Buffer.alloc(8);
  brushCap.writeUInt16LE(0x000f, 0); brushCap.writeUInt16LE(8, 2);
  caps.push(brushCap);

  // CAPSTYPE_GLYPHCACHE (0x0010)
  const glyphCap = Buffer.alloc(52);
  glyphCap.writeUInt16LE(0x0010, 0); glyphCap.writeUInt16LE(52, 2);
  glyphCap.writeUInt8(0, 50); // glyphSupportLevel = GLYPH_SUPPORT_NONE
  caps.push(glyphCap);

  const capsData = Buffer.concat(caps);

  // ConfirmActive PDU body: shareId(4)+originatorId(2)+lengthSrcDesc(2)+lengthCombCaps(2)
  // + sourceDescriptor(9) + numberCapabilities(2) + pad(2) = 23 bytes
  const body = Buffer.alloc(23);
  body.writeUInt32LE(shareId, 0);
  body.writeUInt16LE(0x03EA, 4); // originatorId (client)
  body.writeUInt16LE(9, 6);      // lengthSourceDescriptor
  body.writeUInt16LE(capsData.length + 4, 8); // lengthCombinedCapabilities (+4 for numCaps+pad)
  Buffer.from('autodev\0\0', 'ascii').copy(body, 10); // sourceDescriptor (9 bytes, ends at 18)
  body.writeUInt16LE(caps.length, 19); // numberCapabilities — immediately after sourceDescriptor
  body.writeUInt16LE(0, 21);           // pad2Octets

  const pduBody = Buffer.concat([body, capsData]);

  // Share Control Header
  const shareCtrl = Buffer.alloc(6);
  const pduLen = 6 + pduBody.length;
  shareCtrl.writeUInt16LE(pduLen, 0);
  shareCtrl.writeUInt16LE(PDUTYPE_CONFIRMACTIVEPDU | 0x10, 2); // type | version
  shareCtrl.writeUInt16LE(userId, 4); // PDUSource

  return Buffer.concat([shareCtrl, pduBody]);
}

// ── Synchronize / Control / Font PDUs ────────────────────────────────────

function buildSynchronizePdu(userId: number, shareId: number): Buffer {
  const hdr = buildShareDataHeader(userId, shareId, PDUTYPE2_SYNCHRONIZE, 4);
  const body = Buffer.alloc(4);
  body.writeUInt16LE(1, 0); // messageType = SYNCMSGTYPE_SYNC
  body.writeUInt16LE(1002, 2); // targetUser (MCS user ID)
  return Buffer.concat([hdr, body]);
}

function buildControlPdu(userId: number, shareId: number, action: number): Buffer {
  const hdr = buildShareDataHeader(userId, shareId, PDUTYPE2_CONTROL, 8);
  const body = Buffer.alloc(8);
  body.writeUInt16LE(action, 0);
  body.writeUInt16LE(0, 2);
  body.writeUInt32LE(0, 4);
  return Buffer.concat([hdr, body]);
}

function buildFontListPdu(userId: number, shareId: number): Buffer {
  const hdr = buildShareDataHeader(userId, shareId, PDUTYPE2_FONTLIST, 8);
  const body = Buffer.alloc(8);
  body.writeUInt16LE(0, 0);    // numberFonts
  body.writeUInt16LE(0, 2);    // totalNumFonts
  body.writeUInt16LE(0x0003, 4); // listFlags
  body.writeUInt16LE(50, 6);   // entrySize
  return Buffer.concat([hdr, body]);
}

function buildShareDataHeader(
  userId: number,
  shareId: number,
  pduType2: number,
  dataLen: number,
): Buffer {
  // Share Control Header (6) + Share Data Header (12) = 18 bytes
  const totalBodyLen = dataLen;
  const pduLen = 18 + totalBodyLen;

  const hdr = Buffer.alloc(18);
  // Share Control Header
  hdr.writeUInt16LE(pduLen, 0);
  hdr.writeUInt16LE(PDUTYPE_DATAPDU | 0x10, 2); // type | RDP5 version
  hdr.writeUInt16LE(userId, 4); // PDUSource
  // Share Data Header (TS_SHAREDATAHEADER, 12 bytes at hdr[6..17])
  hdr.writeUInt32LE(shareId, 6);    // shareId
  hdr[10] = 0;                      // pad1Octet
  hdr[11] = 1;                      // streamId (STREAM_LOW)
  hdr.writeUInt16LE(totalBodyLen, 12); // uncompressedLength
  hdr[14] = pduType2;               // pduType2
  hdr[15] = 0;                      // compressType
  hdr.writeUInt16LE(totalBodyLen, 16); // compressedLength
  return hdr.slice(0, 18);
}

function buildRefreshRectPdu(userId: number, shareId: number, width: number, height: number): Buffer {
  // TS_REFRESH_RECT_PDU: numberOfAreas(1) + pad(3) + InclusiveRect (left/top/right/bottom each uint16)
  const body = Buffer.alloc(12);
  body[0] = 1; // numberOfAreas = 1
  body.writeUInt16LE(0, 4);          // left
  body.writeUInt16LE(0, 6);          // top
  body.writeUInt16LE(width - 1, 8);  // right
  body.writeUInt16LE(height - 1, 10); // bottom
  const hdr = buildShareDataHeader(userId, shareId, PDUTYPE2_REFRESH_RECT, body.length);
  return Buffer.concat([hdr, body]);
}

function buildSuppressOutputPdu(userId: number, shareId: number, allow: boolean, width = 0, height = 0): Buffer {
  // TS_SUPPRESS_OUTPUT_PDU: allowDisplayUpdates(1) + pad(3) [+ desktopRect(8) when allow=true]
  const body = allow ? Buffer.alloc(12) : Buffer.alloc(4);
  body[0] = allow ? 1 : 0;
  if (allow) {
    // pad3Octets[1..3] already zero
    body.writeUInt16LE(0, 4);           // left
    body.writeUInt16LE(0, 6);           // top
    body.writeUInt16LE(width - 1, 8);   // right
    body.writeUInt16LE(height - 1, 10); // bottom
  }
  const hdr = buildShareDataHeader(userId, shareId, PDUTYPE2_SUPPRESS_OUTPUT, body.length);
  return Buffer.concat([hdr, body]);
}

// ── Bitmap decompression (RLE — MS-RDPEGDI 3.1.9) ─────────────────────────

function decompressBitmap(
  src: Buffer,
  width: number,
  height: number,
  bytesPerPixel: number,
): Buffer {
  const rowSize = width * bytesPerPixel;
  const dst = Buffer.alloc(rowSize * height);
  let si = 0;
  let di = 0;

  const readPixel = (): Buffer => {
    if (si + bytesPerPixel > src.length) return Buffer.alloc(bytesPerPixel);
    const p = src.slice(si, si + bytesPerPixel);
    si += bytesPerPixel;
    return p;
  };

  while (si < src.length && di < dst.length) {
    if (si >= src.length) break;
    const code = src[si++];
    const type = code >> 4;
    let len  = code & 0x0f;

    if (len === 0) {
      if (si >= src.length) break;
      len = src[si++] + 16;
    }

    if (type === 0x0) {
      // FILL — copy from scanline above
      for (let i = 0; i < len && di < dst.length; i++, di++) {
        dst[di] = di >= rowSize ? dst[di - rowSize] : 0;
      }
    } else if (type === 0x8) {
      // MIX — XOR with previous scanline pixel
      const pixel = readPixel();
      for (let i = 0; i < len && di < dst.length; i++, di += bytesPerPixel) {
        for (let b = 0; b < bytesPerPixel; b++) {
          dst[di + b] = di >= rowSize ? dst[di - rowSize + b] ^ pixel[b] : pixel[b];
        }
        di -= bytesPerPixel;
        di += bytesPerPixel;
      }
    } else if (type === 0xc) {
      // COLOR — repeat pixel
      const pixel = readPixel();
      for (let i = 0; i < len && di + bytesPerPixel <= dst.length; i++, di += bytesPerPixel) {
        pixel.copy(dst, di);
      }
    } else if (type === 0xf) {
      // COPY — raw pixels
      for (let i = 0; i < len && di + bytesPerPixel <= dst.length; i++, di += bytesPerPixel) {
        readPixel().copy(dst, di);
      }
    } else {
      // Unknown / unhandled run type — skip
      si += len * bytesPerPixel;
    }
  }

  return dst;
}

// ── Convert various bit depths to RGBA ────────────────────────────────────

function toRgba(data: Buffer, bytesPerPixel: number): Buffer {
  if (bytesPerPixel === 4) {
    // Assume BGRX (Windows native) → RGBA
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 4) {
      out[i]     = data[i + 2]; // R
      out[i + 1] = data[i + 1]; // G
      out[i + 2] = data[i];     // B
      out[i + 3] = 0xff;        // A
    }
    return out;
  }
  if (bytesPerPixel === 3) {
    // BGR → RGBA
    const pixels = Math.floor(data.length / 3);
    const out = Buffer.alloc(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      out[i * 4]     = data[i * 3 + 2]; // R
      out[i * 4 + 1] = data[i * 3 + 1]; // G
      out[i * 4 + 2] = data[i * 3];     // B
      out[i * 4 + 3] = 0xff;
    }
    return out;
  }
  if (bytesPerPixel === 2) {
    // RGB565 → RGBA
    const pixels = Math.floor(data.length / 2);
    const out = Buffer.alloc(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      const v = data.readUInt16LE(i * 2);
      out[i * 4]     = ((v >> 11) & 0x1f) << 3;
      out[i * 4 + 1] = ((v >> 5)  & 0x3f) << 2;
      out[i * 4 + 2] = (v & 0x1f) << 3;
      out[i * 4 + 3] = 0xff;
    }
    return out;
  }
  // 1 bpp / other — return as-is with alpha=0xff
  const out = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    out[i * 2]     = data[i];
    out[i * 2 + 1] = 0xff;
  }
  return out;
}

// ── RdpBridge class ───────────────────────────────────────────────────────

export class RdpBridge extends EventEmitter {
  private _sock:   net.Socket | tls.TLSSocket | null = null;
  private _closed  = false;
  private _recvBuf = Buffer.alloc(0);
  private _handshakeBuf = Buffer.alloc(0); // raw-byte accumulator for handshake TPKT parsing

  private _width      = RDP_DEFAULT_WIDTH;
  private _height     = RDP_DEFAULT_HEIGHT;
  private _colorDepth = RDP_DEFAULT_COLOR_DEPTH;

  private _userId    = 0;
  private _shareId   = 0;
  private _connected = false;

  // Auto-reconnect support (xrdp closes TCP after initial handshake, expects client to reconnect)
  private _opts:          RdpConnectOptions | null = null;
  private _reconnectCount = 0;
  private static readonly _MAX_RECONNECTS = 10;

  /** Optional external logger — set before calling connect(). */
  log: (msg: string) => void = (msg) => console.error(msg);

  get width()  { return this._width;  }
  get height() { return this._height; }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Connect to an RDP server.  Resolves once the desktop is ready.
   */
  async connect(opts: RdpConnectOptions): Promise<RdpInfo> {
    this._opts = opts; // save for auto-reconnect

    const host       = opts.host;
    const port       = opts.port       ?? RDP_DEFAULT_PORT;
    const username   = opts.username   ?? '';
    const password   = opts.password   ?? '';
    const domain     = opts.domain     ?? '';
    const width      = opts.width      ?? RDP_DEFAULT_WIDTH;
    const height     = opts.height     ?? RDP_DEFAULT_HEIGHT;
    const colorDepth = opts.colorDepth ?? RDP_DEFAULT_COLOR_DEPTH;

    this._width      = width;
    this._height     = height;
    this._colorDepth = colorDepth;

    return new Promise<RdpInfo>((resolve, reject) => {
      // connectResolved: true once the initial handshake has resolved the Promise.
      // The rawSock 'close' listener uses this guard so it doesn't emit 'close'
      // after the TLS socket takes over (the TLS 'close' handler manages reconnect).
      let connectResolved = false;
      const sock = net.createConnection({ host, port });
      this._sock = sock;

      sock.once('error', (err) => {
        if (!this._closed) { this._closed = true; this.emit('error', err); reject(err); }
      });
      sock.once('close', () => {
        // Only fire if the Promise never resolved (pre-Phase-8 failure on raw socket)
        if (!connectResolved && !this._closed) { this._closed = true; this.emit('close'); }
      });

      sock.once('connect', async () => {
        try {
          await this._handshake(
            sock, host, port, username, password, domain, width, height, colorDepth,
            (info) => { connectResolved = true; resolve(info); },
            reject,
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          sock.destroy();
        }
      });
    });
  }

  /** Send a mouse event. buttonMask: bit0=left, bit1=right, bit2=middle */
  sendMouse(x: number, y: number, buttonMask: number): void {
    if (!this._userId || !this._connected) return;

    let flags = PTRFLAGS_MOVE;
    if (buttonMask & 1) flags |= PTRFLAGS_BUTTON1 | PTRFLAGS_DOWN;
    if (buttonMask & 2) flags |= PTRFLAGS_BUTTON2 | PTRFLAGS_DOWN;
    if (buttonMask & 4) flags |= PTRFLAGS_BUTTON3 | PTRFLAGS_DOWN;

    this._sendInput(INPUT_EVENT_MOUSE, Buffer.from([
      flags & 0xff, (flags >> 8) & 0xff,
      x & 0xff, (x >> 8) & 0xff,
      y & 0xff, (y >> 8) & 0xff,
    ]));
  }

  /** Send a key event. jsKeyCode is the browser keyCode value. */
  sendKey(jsKeyCode: number, down: boolean): void {
    if (!this._userId || !this._connected) return;

    const scanCode = RDP_SCANCODE[jsKeyCode] ?? jsKeyCode;
    const isExt    = RDP_EXTENDED_KEYS.has(jsKeyCode);

    let flags = down ? 0 : KBDFLAGS_RELEASE;
    if (isExt) flags |= KBDFLAGS_EXTENDED;

    this._sendInput(INPUT_EVENT_SCANCODE, Buffer.from([
      flags & 0xff, (flags >> 8) & 0xff,
      scanCode & 0xff, (scanCode >> 8) & 0xff,
      0, 0,
    ]));
  }

  /** Push local clipboard text to the remote. */
  sendClipboardText(text: string): void {
    // Clipboard redirection requires the cliprdr channel (Phase 2).
    // For now, log silently — no-op until channel join is implemented.
    void text;
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      this._sock?.destroy();
      this._sock = null;
    }
  }

  // ── Auto-reconnect ─────────────────────────────────────────────────────

  /**
   * Reconnect using saved opts — called after xrdp's clean TCP close that
   * follows the initial session-creation handshake.
   */
  private _doReconnect(): void {
    if (this._closed || !this._opts) return;
    const opts = this._opts;
    const host       = opts.host;
    const port       = opts.port       ?? RDP_DEFAULT_PORT;
    const username   = opts.username   ?? '';
    const password   = opts.password   ?? '';
    const domain     = opts.domain     ?? '';
    const width      = opts.width      ?? RDP_DEFAULT_WIDTH;
    const height     = opts.height     ?? RDP_DEFAULT_HEIGHT;
    const colorDepth = opts.colorDepth ?? RDP_DEFAULT_COLOR_DEPTH;

    this._width      = width;
    this._height     = height;
    this._colorDepth = colorDepth;

    const sock = net.createConnection({ host, port });
    this._sock = sock;

    sock.once('error', (err) => {
      this.log(`[RDP] reconnect socket error: ${err.message}`);
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' && this._connected) return;
      if (!this._closed) { this._closed = true; this.emit('error', err); }
    });

    sock.once('connect', async () => {
      try {
        await this._handshake(
          sock, host, port, username, password, domain, width, height, colorDepth,
          (_info) => { this.log('[RDP] reconnect complete — desktop ready'); },
          (err)   => {
            this.log(`[RDP] reconnect handshake failed: ${err.message}`);
            if (!this._closed) { this._closed = true; this.emit('error', err); }
          },
        );
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.log(`[RDP] reconnect exception: ${e.message}`);
        if (!this._closed) { this._closed = true; this.emit('error', e); }
        sock.destroy();
      }
    });
  }

  // ── Handshake ──────────────────────────────────────────────────────────

  private async _handshake(
    rawSock: net.Socket,
    host: string,
    _port: number,
    username: string,
    password: string,
    domain: string,
    width: number,
    height: number,
    colorDepth: number,
    resolve: (info: RdpInfo) => void,
    reject: (err: Error) => void,
  ): Promise<void> {

    // ── Phase 1: X.224 negotiation ─────────────────────────────────────
    const reqProtocol = selectRequestProtocol();
    rawSock.write(buildX224ConnectRequest(reqProtocol, username));

    const cc = await this._readTpkt(rawSock);
    const selectedProtocol = parseX224ConnectConfirm(cc);
    this.log(`[RDP] Phase1 done — selectedProtocol=${selectedProtocol}`);

    // ── Phase 2: TLS upgrade ───────────────────────────────────────────
    let sock: net.Socket | tls.TLSSocket = rawSock;
    if (selectedProtocol !== 0 /* PROTOCOL_RDP */) {
      sock = await upgradeTls(rawSock, host);
      this._sock = sock;
    }
    this.log(`[RDP] Phase2 done — TLS=${selectedProtocol !== 0}`);

    // Attach error/close monitors — these must be in place before we send
    // anything so we can surface failures immediately.  We do NOT install the
    // _recvBuf 'data' listener here; that is done inside _runLoop so that
    // handshake packets read via _readTpkt are not also buffered in _recvBuf.
    sock.on('error', (err) => {
      this.log(`[RDP] socket error: ${err.message}`);
      // ECONNRESET while connected = xrdp closing for reconnect; let 'close' handler decide
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' && this._connected) return;
      if (!this._closed) { this._closed = true; this.emit('error', err); }
    });
    sock.on('close', () => {
      this.log(`[RDP] socket closed (connected=${this._connected})`);
      if (this._closed) return;
      // xrdp closes TCP after initial session setup — auto-reconnect for actual desktop
      if (this._connected && this._opts && this._reconnectCount < RdpBridge._MAX_RECONNECTS) {
        this._reconnectCount++;
        this.log(`[RDP] clean close — auto-reconnect ${this._reconnectCount}/${RdpBridge._MAX_RECONNECTS}`);
        this._connected = false;
        this._userId    = 0;
        this._shareId   = 0;
        this._recvBuf   = Buffer.alloc(0);
        this._handshakeBuf = Buffer.alloc(0);
        this._sock      = null;
        // Progressive delay: give xrdp time to start the X session backend
        const delayMs = Math.min(1000 * this._reconnectCount, 5000);
        setTimeout(() => this._doReconnect(), delayMs);
      } else {
        this._closed = true;
        this.emit('close');
      }
    });

    // ── Phase 3: MCS Connect ───────────────────────────────────────────
    const mcsInit = buildMcsConnectInitial(width, height, colorDepth);
    this._sendX224Data(sock, mcsInit);

    const mcsResp = await this._readTpktPayload(sock);
    // Parse MCS ConnectResponse to extract server data (GCC) — we only need userId seed
    // Most fields are not critical for basic connectivity; skip deep parsing for now.
    void mcsResp;

    // ── Phase 4: MCS Erect Domain + Attach User ────────────────────────
    this._sendX224Data(sock, Buffer.from([MCS_ERECT_DOMAIN_REQUEST, 0x00, 0x01, 0x00, 0x01]));
    this._sendX224Data(sock, Buffer.from([MCS_ATTACH_USER_REQUEST]));

    const auConf = await this._readTpktPayload(sock);
    if (auConf[0] !== MCS_ATTACH_USER_CONFIRM) {
      throw new Error(`Expected MCS_ATTACH_USER_CONFIRM, got 0x${auConf[0].toString(16)}`);
    }
    this._userId = 1001 + auConf.readUInt16BE(2);
    this.log(`[RDP] Phase4 done — userId=${this._userId}`);

    // ── Phase 5: Channel joins ─────────────────────────────────────────
    for (const channelId of [this._userId, MCS_CHANNEL_GLOBAL]) {
      const joinReq = Buffer.alloc(5);
      joinReq[0] = MCS_CHANNEL_JOIN_REQUEST;
      joinReq.writeUInt16BE(this._userId - 1001, 1);
      joinReq.writeUInt16BE(channelId, 3);
      this._sendX224Data(sock, joinReq);

      const joinConf = await this._readTpktPayload(sock);
      if (joinConf[0] !== MCS_CHANNEL_JOIN_CONFIRM) {
        throw new Error(`MCS channel join failed for channel ${channelId}`);
      }
    }

    // ── Phase 6: Client Info (login) ───────────────────────────────────
    const clientInfo = buildClientInfoPdu(username, password, domain);
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, clientInfo);
    this.log(`[RDP] Phase6 sent ClientInfo`);

    // ── Phase 6b: License exchange ─────────────────────────────────────
    await this._doLicenseExchange(sock, username);
    this.log(`[RDP] Phase6b license exchange done`);

    // ── Phase 7: Capability exchange ──────────────────────────────────
    // Wait for Demand Active PDU from server
    const demandPdu = await this._waitForPduType(sock, PDUTYPE_DEMANDACTIVEPDU, 15_000);
    this._shareId = demandPdu.readUInt32LE(6); // shareId in Share Control Header
    this.log(`[RDP] Phase7 DemandActive — shareId=0x${this._shareId.toString(16)}`);

    const confirmActive = buildConfirmActivePdu(this._userId, this._shareId, width, height);
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, confirmActive);
    this.log(`[RDP] Phase7 ConfirmActive sent, sending sync/ctrl/fontlist`);

    // Send synchronize + control + font list (required sequence per MS-RDPBCGR §1.3.1.1)
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, buildSynchronizePdu(this._userId, this._shareId));
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, buildControlPdu(this._userId, this._shareId, 4 /*CTRLACTION_COOPERATE*/));
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, buildControlPdu(this._userId, this._shareId, 1 /*CTRLACTION_REQUEST_CONTROL*/));
    this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, buildFontListPdu(this._userId, this._shareId));

    // ── Phase 8: Running ───────────────────────────────────────────────
    this._connected = true;

    const info: RdpInfo = {
      name:       host,
      width,
      height,
      colorDepth,
    };

    resolve(info);

    // Start continuous parsing
    this._runLoop(sock);
  }

  // ── License exchange ──────────────────────────────────────────────────

  /**
   * Handle RDP license exchange after Client Info PDU.
   * Responds to SERVER_LICENSE_REQUEST and PLATFORM_CHALLENGE until the
   * server completes licensing (or sends a non-license PDU).
   */
  private async _doLicenseExchange(
    sock: net.Socket | tls.TLSSocket,
    username: string,
  ): Promise<void> {
    const SEC_LICENSE_PKT = 0x0080;
    let clientRand: Buffer | undefined;
    let preMaster:  Buffer | undefined;
    let serverRand: Buffer | undefined;
    let macKey:     Buffer | undefined;
    let encKey:     Buffer | undefined;

    for (let i = 0; i < 10; i++) {
      const tpkt = await this._readTpkt(sock);
      // Parse MCS SDI header to find the RDP/license payload
      const payload = tpkt.slice(7);  // skip TPKT(4)+X224(3)
      if (payload.length < 7 || payload[0] !== MCS_SEND_DATA_INDICATION) {
        // Not an SDI — put it back and stop
        this._handshakeBuf = Buffer.concat([tpkt, this._handshakeBuf]);
        return;
      }
      let off = 6;
      const lb = payload[off++];
      if (lb & 0x80) off++; // T.125 PER 2-byte form: [0x80|hi, lo] — skip the low byte
      const rdp = payload.slice(off);
      if (rdp.length < 6) continue;

      const secFlags = rdp.readUInt16LE(0);
      if (!(secFlags & SEC_LICENSE_PKT)) {
        // Not a license packet (could be Demand Active) — put it back
        this._handshakeBuf = Buffer.concat([tpkt, this._handshakeBuf]);
        return;
      }

      const body = rdp.slice(4); // skip 4-byte security header
      const msgType = body[0];

      if (msgType === 0x01) { // SERVER_LICENSE_REQUEST
        const { serverRand: sr, modulusLe, exponent } = parseLicenseRequest(body);
        serverRand = sr;
        clientRand = crypto.randomBytes(32);
        preMaster  = crypto.randomBytes(48);
        const encPms = rsaEncryptLe(preMaster, modulusLe, exponent);
        const req = buildNewLicenseRequest(clientRand, encPms, username, 'autodev');
        const secHdr = Buffer.from([0x80, 0x00, 0x00, 0x00]); // SEC_LICENSE_PKT
        this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, Buffer.concat([secHdr, req]));

      } else if (msgType === 0x02 && clientRand && preMaster && serverRand) { // PLATFORM_CHALLENGE
        [macKey, encKey] = deriveLicenseKeys(preMaster, clientRand, serverRand);
        const chalLen     = body.readUInt16LE(6);
        const encChal     = body.slice(8, 8 + chalLen);
        const challenge   = rc4(encKey, encChal);
        const resp = buildPlatformChallengeResponse(encKey, macKey, challenge);
        const secHdr = Buffer.from([0x80, 0x00, 0x00, 0x00]);
        this._sendMcsData(sock, MCS_CHANNEL_GLOBAL, Buffer.concat([secHdr, resp]));

      } else if (msgType === 0x03 || msgType === 0xff) {
        // NEW_LICENSE or ERROR_ALERT — licensing done regardless of error code
        return;
      }
    }
  }

  // ── Run loop ─────────────────────────────────────────────────────────

  private _runLoop(sock: net.Socket | tls.TLSSocket): void {
    this.log(`[RDP] runLoop started (handshakeBuf=${this._handshakeBuf.length} bytes)`);
    const pump = () => {
      while (true) {
        const pdu = this._tryParseTpkt();
        if (!pdu) break;
        try { this._dispatchPdu(pdu); } catch (e) {
          this.log(`[RDP] dispatchPdu error: ${e}`);
        }
      }
    };
    // Drain any bytes left over from handshake phase into _recvBuf
    if (this._handshakeBuf.length > 0) {
      this._recvBuf = Buffer.concat([this._recvBuf, this._handshakeBuf]);
      this._handshakeBuf = Buffer.alloc(0);
    }
    // Install _recvBuf listener here (not during handshake) so that
    // _readTpkt's own listeners are the sole consumers during negotiation.
    sock.on('data', (chunk: Buffer) => {
      this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
      pump();
    });
    pump();
  }

  private _dispatchPdu(data: Buffer): void {
    if (data.length < 4) return;

    // X.224 Data TPDU header is 3 bytes (LI=2, code=F0, EOT=80)
    const x224Start = 4; // after TPKT
    if (data[x224Start + 1] !== X224_TPDU_DATA) return;
    const payload = data.slice(x224Start + 3);

    if (payload.length < 1) return;
    const mcsOpcode = payload[0];

    // MCS SendDataIndication
    if (mcsOpcode !== MCS_SEND_DATA_INDICATION) return;
    if (payload.length < 8) return;

    // Decode MCS SDI PER/BER length field.
    // MCS fixed header: opcode(1)+initiator(2)+channelId(2)+priority(1) = 6 bytes.
    let offset = 6;
    const lenByte = payload[offset];
    offset++;
    if (lenByte & 0x80) {
      offset++; // T.125 PER 2-byte form: [0x80|hi, lo] — skip the low byte
    }

    const rdpPayload = payload.slice(offset);
    if (rdpPayload.length < 6) return;

    // With TLS (no RDP-level encryption), run-loop PDUs have no security header.
    // rdpPayload starts directly with the Share Control Header.
    const shareCtrl = rdpPayload;
    if (shareCtrl.length < 6) return;
    const pduType = shareCtrl.readUInt16LE(2) & 0x0f;
    this.log(`[RDP] runLoop PDU: pduType=0x${pduType.toString(16)} len=${shareCtrl.length}`);

    if (pduType === (PDUTYPE_DATAPDU & 0x0f)) {
      const body = shareCtrl.slice(6);
      const pt2 = body.length >= 9 ? body[8] : -1;
      this.log(`[RDP]   DataPDU pduType2=0x${pt2.toString(16)}`);
      this._handleDataPdu(body);
    } else if (pduType === (PDUTYPE_DEMANDACTIVEPDU & 0x0f)) {
      // Re-issued demand active — re-confirm and re-sync
      this._shareId = shareCtrl.readUInt32LE(6);
      if (this._sock) {
        const s = this._sock;
        const confirm = buildConfirmActivePdu(this._userId, this._shareId, this._width, this._height);
        this._sendMcsData(s, MCS_CHANNEL_GLOBAL, confirm);
        this._sendMcsData(s, MCS_CHANNEL_GLOBAL, buildSynchronizePdu(this._userId, this._shareId));
        this._sendMcsData(s, MCS_CHANNEL_GLOBAL, buildControlPdu(this._userId, this._shareId, 4));
        this._sendMcsData(s, MCS_CHANNEL_GLOBAL, buildControlPdu(this._userId, this._shareId, 1));
        this._sendMcsData(s, MCS_CHANNEL_GLOBAL, buildFontListPdu(this._userId, this._shareId));
      }
    }
  }

  private _handleDataPdu(body: Buffer): void {
    if (body.length < 12) return;
    // TS_SHAREDATAHEADER: shareId(4)+pad(1)+streamId(1)+uncompressedLength(2)+pduType2(1)
    const pduType2 = body[8];

    if (pduType2 === PDUTYPE2_UPDATE) {
      if (body.length >= 14) {
        const updateType = body.readUInt16LE(12);
        this.log(`[RDP]   UpdatePDU updateType=0x${updateType.toString(16)}`);
      }
      this._handleUpdatePdu(body.slice(12));
    } else if (pduType2 === PDUTYPE2_FONTMAP) {
      // Server finished capability sequence.
      // Send TS_SYNCHRONIZE_EVENT (keyboard state sync) to signal client readiness.
      // Do NOT send SuppressOutput/RefreshRect here — xrdp's Xvnc backend crashes on them
      // before it has fully started; just send INPUT_SYNC and let xrdp push updates.
      this._connected = true;
      if (this._sock) {
        // toggleFlags=0: no CapsLock/NumLock/ScrollLock
        this._sendInput(INPUT_EVENT_SYNC, Buffer.from([0, 0, 0, 0, 0, 0]));
        this.log('[RDP] FontMap received — sent INPUT_SYNC');
      }
    }
  }

  private _handleUpdatePdu(body: Buffer): void {
    if (body.length < 2) return;
    const updateType = body.readUInt16LE(0);

    if (updateType === UPDATE_BITMAP) {
      this._parseBitmapUpdate(body.slice(2));
    } else if (updateType === 0x0003 /* UPDATETYPE_SYNCHRONIZE */) {
      // xrdp backend is syncing — wait before requesting a full-screen refresh
      // to give the Xvnc backend time to start up
      if (this._sock && !this._closed) {
        const s = this._sock;
        setTimeout(() => {
          if (!this._closed && this._connected && s === this._sock) {
            this._sendMcsData(s, MCS_CHANNEL_GLOBAL,
              buildRefreshRectPdu(this._userId, this._shareId, this._width, this._height));
            this.log('[RDP] UPDATETYPE_SYNCHRONIZE — sent RefreshRect (delayed)');
          }
        }, 2000);
      }
    }
    // UPDATE_ORDERS and UPDATE_POINTER can be added in Phase 2
  }

  private _parseBitmapUpdate(data: Buffer): void {
    if (data.length < 2) return;
    const numRects = data.readUInt16LE(0); // TS_BITMAP_DATA_ARRAY: numberRectangles
    let offset = 2;
    const rects: RdpRect[] = [];

    for (let i = 0; i < numRects; i++) {
      if (offset + 18 > data.length) break;

      const x    = data.readUInt16LE(offset);
      const y    = data.readUInt16LE(offset + 2);
      const w    = data.readUInt16LE(offset + 4) - x + 1;  // destRight - destLeft + 1
      const h    = data.readUInt16LE(offset + 6) - y + 1;  // destBottom - destTop + 1
      // offset+8 = width (bitmap pixels), offset+10 = height (bitmap pixels) — skipped
      const bpp       = data.readUInt16LE(offset + 12); // bitsPerPixel
      const flags     = data.readUInt16LE(offset + 14); // flags
      const bitmapLen = data.readUInt16LE(offset + 16); // bitmapLength
      offset += 18;

      if (offset + bitmapLen > data.length) break;
      const bitmapData = data.slice(offset, offset + bitmapLen);
      offset += bitmapLen;

      const bpp8 = Math.ceil(bpp / 8);
      let raw: Buffer;

      if (flags & BITMAP_COMPRESSION && !(flags & NO_BITMAP_COMPRESSION_HDR)) {
        // Compressed with standard header (12 bytes)
        raw = decompressBitmap(bitmapData.slice(12), w, h, bpp8);
      } else if (flags & BITMAP_COMPRESSION) {
        raw = decompressBitmap(bitmapData, w, h, bpp8);
      } else {
        raw = bitmapData;
      }

      // RDP sends bottom-up bitmaps — flip vertically
      const rowSize = w * bpp8;
      const flipped = Buffer.alloc(raw.length);
      for (let row = 0; row < h; row++) {
        raw.copy(flipped, row * rowSize, (h - 1 - row) * rowSize, (h - row) * rowSize);
      }

      rects.push({ x, y, w, h, data: toRgba(flipped, bpp8) });
    }

    if (rects.length > 0) {
      this.emit('fbu', rects);
    }
  }

  // ── Input helper ──────────────────────────────────────────────────────

  private _sendInput(eventType: number, eventData: Buffer): void {
    if (!this._sock || !this._userId) return;

    // TS_INPUT_PDU_DATA: numEvents(2) + pad(2) + [TS_INPUT_EVENT: eventTime(4) + messageType(2) + slowPathData(6)]
    const event = Buffer.alloc(16);
    event.writeUInt16LE(1, 0);          // numEvents
    event.writeUInt16LE(0, 2);          // pad
    event.writeUInt32LE(0, 4);          // eventTime (0 = server picks)
    event.writeUInt16LE(eventType, 8);  // messageType
    if (eventData.length >= 6) {
      eventData.copy(event, 10, 0, 6);  // slowPathData at offset 10
    }

    const shareHdr = buildShareDataHeader(this._userId, this._shareId, PDUTYPE2_INPUT, event.length);
    this._sendMcsData(this._sock, MCS_CHANNEL_GLOBAL, Buffer.concat([shareHdr, event]));
  }

  // ── Low-level send helpers ─────────────────────────────────────────────

  private _sendX224Data(sock: net.Socket | tls.TLSSocket, payload: Buffer): void {
    sock.write(wrapTpkt(wrapX224Data(payload)));
  }

  private _sendMcsData(sock: net.Socket | tls.TLSSocket, channelId: number, payload: Buffer): void {
    const mcs = wrapMcsSend(this._userId, channelId, payload);
    this._sendX224Data(sock, mcs);
  }

  // ── Receive helpers ───────────────────────────────────────────────────

  /** Read a complete TPKT from the given socket (used during handshake only). */
  private _readTpkt(sock: net.Socket | tls.TLSSocket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tryExtract = (): boolean => {
        if (this._handshakeBuf.length < 4) return false;
        const len = this._handshakeBuf.readUInt16BE(2);
        if (this._handshakeBuf.length < len) return false;
        const pkt = this._handshakeBuf.slice(0, len);
        this._handshakeBuf = this._handshakeBuf.slice(len); // preserve remainder
        resolve(pkt);
        return true;
      };
      if (tryExtract()) return; // already buffered enough
      const onData = (chunk: Buffer) => {
        this._handshakeBuf = Buffer.concat([this._handshakeBuf, chunk]);
        if (tryExtract()) sock.off('data', onData);
      };
      sock.on('data', onData);
      setTimeout(() => { sock.off('data', onData); reject(new Error('TPKT read timeout')); }, 15_000);
    });
  }

  /** Read a TPKT and return only the payload (after TPKT+X.224 headers). */
  private async _readTpktPayload(sock: net.Socket | tls.TLSSocket): Promise<Buffer> {
    const full = await this._readTpkt(sock);
    // TPKT(4) + X.224 Data header(3) = 7
    return full.slice(7);
  }

  /**
   * Wait for an RDP PDU with a specific pduType in the Share Control Header.
   * Times out after `timeoutMs` ms.
   */
  private _waitForPduType(
    sock: net.Socket | tls.TLSSocket,
    pduType: number,
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Seed with any bytes buffered during license exchange
      let buf = this._handshakeBuf;
      this._handshakeBuf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        sock.off('data', onData);
        reject(new Error(`Timeout waiting for PDU type 0x${pduType.toString(16)}`));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        // Try to extract complete TPKT packets
        while (buf.length >= 4) {
          const len = buf.readUInt16BE(2);
          if (buf.length < len) break;
          const tpkt = buf.slice(0, len);
          buf = buf.slice(len);

          // Decode MCS → RDP
          if (tpkt.length < 11) continue;
          const mcsPayload = tpkt.slice(7); // skip TPKT(4) + X224(3)
          if (mcsPayload[0] !== MCS_SEND_DATA_INDICATION) continue;

          // MCS fixed header: opcode(1)+initiator(2)+channelId(2)+priority(1) = 6 bytes
          let offset = 6;
          const lb = mcsPayload[offset++];
          if (lb & 0x80) offset++; // T.125 PER 2-byte form: skip low byte
          const rdp = mcsPayload.slice(offset);
          if (rdp.length < 6) continue;
          // With TLS, Demand Active has no security header — rdp IS the Share Control Header.
          const t = rdp.readUInt16LE(2) & 0x0f;
          if (t === (pduType & 0x0f)) {
            clearTimeout(timer);
            sock.off('data', onData);
            // Save any remaining bytes so _runLoop can consume them
            this._handshakeBuf = Buffer.concat([buf, this._handshakeBuf]);
            buf = Buffer.alloc(0);
            resolve(rdp);
            return;
          }
        }
      };

      sock.on('data', onData);
      // Process any pre-seeded data immediately
      if (buf.length > 0) onData(Buffer.alloc(0));
    });
  }

  /** Try to parse one complete TPKT from _recvBuf without blocking.
   * Fast-path PDUs (first byte != 0x03) are skipped with a warning since we
   * advertise no fast-path support; they should not appear, but guard anyway. */
  private _tryParseTpkt(): Buffer | null {
    if (this._recvBuf.length < 4) return null;
    if (this._recvBuf[0] !== 0x03) {
      // Not a TPKT — could be a stray fast-path byte. Scan forward to next 0x03.
      this.log(`[RDP] warn: non-TPKT byte 0x${this._recvBuf[0].toString(16)} — skipping`);
      const next = this._recvBuf.indexOf(0x03, 1);
      this._recvBuf = next >= 0 ? this._recvBuf.slice(next) : Buffer.alloc(0);
      return null;
    }
    const len = this._recvBuf.readUInt16BE(2);
    if (len < 4) { this._recvBuf = this._recvBuf.slice(4); return null; } // guard
    if (this._recvBuf.length < len) return null;
    const pkt = this._recvBuf.slice(0, len);
    this._recvBuf = this._recvBuf.slice(len);
    return pkt;
  }
}
