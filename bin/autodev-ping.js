#!/usr/bin/env node
// Quick WS-handshake verifier. Reads wsUrl from <cwd>/.autodev/settings.json
// (or .vscode/autodev.json), opens a WebSocket connection, waits for the
// server's first frame (or a 2s grace period), then exits 0 on success.

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const crypto = require('crypto');

const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
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

console.log(`Connecting to ${wsUrl}…`);
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
    'User-Agent': 'autodev-ping',
  },
});

req.on('upgrade', (res, socket) => {
  console.log('Handshake OK — status', res.statusCode);
  let closed = false;
  socket.on('data', (buf) => {
    if (closed) return;
    closed = true;
    console.log('First frame:', buf.length, 'bytes — server is talking.');
    try { socket.destroy(); } catch {}
    setTimeout(() => process.exit(0), 50);
  });
  setTimeout(() => {
    if (closed) return;
    console.log('No frame in 2.5s, but handshake succeeded — connection is alive.');
    try { socket.destroy(); } catch {}
    process.exit(0);
  }, 2500);
});

req.on('response', (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.error(`Server returned HTTP ${res.statusCode} (no upgrade): ${body.slice(0, 300)}`);
    process.exit(2);
  });
});

req.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(2);
});

req.setTimeout(10_000, () => {
  console.error('Timed out waiting for handshake');
  req.destroy();
  process.exit(2);
});

req.end();
