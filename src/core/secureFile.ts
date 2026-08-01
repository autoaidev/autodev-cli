import * as fs from 'fs';

// ---------------------------------------------------------------------------
// secureFile — write credential-bearing files owner-only (mode 0600).
//
// Several config files the CLI writes carry live secrets: `.autodev/settings.json`
// (serverApiKey + wsUrl token), `.mcp.json` and the per-provider MCP configs
// (.vscode/mcp.json, opencode.json, the copilot per-workspace config, the grok
// config.toml) which embed the pixel-office A2A bearer token. On a shared /
// multi-user box the default umask leaves these world-readable (0644), so any
// other local user can lift the token and impersonate the agent.
//
// This mirrors the desktop app's handling in
// autodev-app/src/main/pixelOffice.ts: writeFileSync with { mode: 0o600 } AND a
// follow-up chmodSync(0o600). The mode option only applies when the file is
// CREATED; chmodSync additionally tightens a pre-existing file that a previous
// (looser) CLI version may have written world-readable.
// ---------------------------------------------------------------------------

/**
 * Write `data` to `file` with owner-only (0600) permissions.
 *
 * - `{ mode: 0o600 }` sets the permission when the file is newly created.
 * - `fs.chmodSync(file, 0o600)` also tightens any pre-existing file (the mode
 *   option is ignored by the OS when the file already exists).
 *
 * The chmod is best-effort — on platforms/filesystems that don't support POSIX
 * modes (e.g. some Windows setups) it may throw, which must never break a write.
 */
export function writeFileSecure(file: string, data: string | Uint8Array): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort — non-POSIX fs */ }
}
