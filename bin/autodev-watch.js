#!/usr/bin/env node
// Long-lived WS watcher — opens the agent's WebSocket and prints all text
// frames received. Use this to verify task delivery end-to-end.
//
// Usage: node autodev-watch.js [workspaceDir] [seconds]
//   default workspaceDir = cwd
//   default seconds      = 30
//
// Reads wsUrl from <workspaceDir>/.autodev/settings.json (or .vscode/autodev.json).

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const crypto = require('crypto');

const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const watchSeconds = process.argv[3] ? Number(process.argv[3]) : 30;

const candidates = [
  path.join(cwd, '.autodev', 'settings.json'),
  path.join(cwd, '.vscode', 'autodev.json'),
];
const file = candidates.find(p => fs.existsSync(p));
if (!file) { console.error('No settings file found in', cwd); process.exit(1); }
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const wsUrl = settings.wsUrl;
if (!wsUrl) { console.error('settings.wsUrl is empty'); process.exit(1); }

const u = new URL(wsUrl);
const isTls = u.protocol === 'wss:';
const lib = isTls ? https : http;
const port = u.port ? Number(u.port) : (isTls ? 443 : 80);
const key = crypto.randomBytes(16).toString('base64');

console.log(`[watch] Connecting to ${wsUrl}`);
console.log(`[watch] Watching for ${watchSeconds}s, then exiting.`);

const req = lib.request({
  host: u.hostname,
  port,
  path: u.pathname + u.search,
  method: 'GET',
  headers: {
    'Connection': 'Upgrade',
    'Upgrade': 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    'Origin': `${u.protocol}//${u.hostname}`,
    'User-Agent': 'autodev-watch',
  },
});

req.on('upgrade', (res, socket) => {
  console.log(`[watch] Handshake OK — status ${res.statusCode}`);

  // Minimal RFC 6455 frame parser. Server-to-client frames are unmasked.
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin    = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len      = buf[1] & 0x7f;
      let off      = 2;

      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }

      let mask = null;
      if (masked) { if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;

      let payload = buf.slice(off, off + len);
      if (mask) {
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buf = buf.slice(off + len);

      if (opcode === 0x1) {           // text frame
        const text = payload.toString('utf8');
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] ← ${truncate(text, 800)}`);
      } else if (opcode === 0x9) {    // ping → pong
        const pong = makeMaskedFrame(0xa, payload);
        socket.write(pong);
      } else if (opcode === 0x8) {    // close
        console.log(`[watch] Server closed the connection.`);
        socket.end();
        process.exit(0);
      }
      if (!fin) break; // continuation handling intentionally minimal
    }
  });

  socket.on('error', (e) => { console.error('[watch] socket error:', e.message); process.exit(1); });
  socket.on('close', () => { console.log('[watch] socket closed'); process.exit(0); });

  setTimeout(() => {
    console.log(`[watch] ${watchSeconds}s elapsed — exiting.`);
    try { socket.end(); } catch {}
    setTimeout(() => process.exit(0), 100);
  }, watchSeconds * 1000);
});

req.on('response', (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.error(`[watch] Server returned HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
    process.exit(2);
  });
});
req.on('error', (err) => { console.error('[watch] Connection error:', err.message); process.exit(2); });
req.end();

function makeMaskedFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126)        header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else                  { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + ` … (+${s.length - n} bytes)` : s; }
