// Offline smoke — credential-bearing config files must be written owner-only
// (mode 0600) so another local user on a shared box can't lift the office
// bearer token / serverApiKey. Covers both the shared helper directly and the
// real connect + MCP-sync write paths.
//
// Mirrors the desktop app's handling in autodev-app/src/main/pixelOffice.ts
// (writeFileSync { mode: 0o600 } + chmodSync 0o600).
// Run: node test/secureFilePerms.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { writeFileSecure } = await import('../out/core/secureFile.js');
const { applyWsUrl } = await import('../out/connect.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// POSIX-only assertion: on platforms without POSIX modes chmod is a best-effort
// no-op and this check doesn't apply.
const posix = process.platform !== 'win32';
const mode = (f) => fs.statSync(f).mode & 0o777;
const assertOwnerOnly = (f) => {
  if (!posix) return;
  assert.strictEqual(mode(f), 0o600, `${path.basename(f)} must be mode 0600, got ${mode(f).toString(8)}`);
};

console.log('secure file perms smoke');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-secperm-')));

ok('writeFileSecure creates a new file as 0600', () => {
  const f = path.join(dir, 'fresh.json');
  writeFileSecure(f, JSON.stringify({ token: 'agt_secret' }));
  assertOwnerOnly(f);
});

ok('writeFileSecure tightens a pre-existing world-readable (0644) file', () => {
  const f = path.join(dir, 'preexisting.json');
  // Simulate a file left behind by an older, looser CLI version.
  fs.writeFileSync(f, '{}', { mode: 0o644 });
  if (posix) fs.chmodSync(f, 0o644); // force loose regardless of umask
  writeFileSecure(f, JSON.stringify({ token: 'agt_secret' }));
  assertOwnerOnly(f);
});

// Real bind path: token + endpoint embedded (what the office hands out).
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-secperm-ws-')));
applyWsUrl(ws, 'wss://autodev.code.aioffice.works/ws?token=agt_TESTKEY1234567890&endpoint=legal-parser-test');

ok('.autodev/settings.json (serverApiKey + wsUrl token) is 0600', () => {
  const f = path.join(ws, '.autodev', 'settings.json');
  assert.ok(fs.existsSync(f), 'settings.json must be written on bind');
  // Sanity: the secret really is in there.
  assert.ok(fs.readFileSync(f, 'utf8').includes('agt_TESTKEY'), 'settings holds the token');
  assertOwnerOnly(f);
});

ok('.mcp.json (MCP config) is 0600', () => {
  const f = path.join(ws, '.mcp.json');
  assert.ok(fs.existsSync(f), '.mcp.json must be written on bind');
  assertOwnerOnly(f);
});

ok('every provider MCP config that got written is 0600', () => {
  // These are written by ConfigManager.syncProjectMcpServers when they apply on
  // this platform; assert perms only on the ones that actually exist.
  for (const rel of ['.vscode/mcp.json', 'opencode.json', '.grok/config.toml']) {
    const f = path.join(ws, rel);
    if (fs.existsSync(f)) assertOwnerOnly(f);
  }
});

console.log(`\n${pass} checks passed`);
