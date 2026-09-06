#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gen-gimp-plugin-source.mjs — generate src/core/gimpPluginSource.ts from the
// canonical media/gimp/gimp_mcp_server.py.
//
// WHY: installGimpPlugin() used to READ media/gimp/gimp_mcp_server.py at runtime
// via path.join(__dirname, ...). That works in the CLI process (and the app's
// bundled-CLI subprocess, where media/ ships) but FAILS when this code is
// esbuild-bundled into the VS Code extension — there is no media file on disk at
// runtime. Embedding the plugin body as a string constant makes the installer
// bundle-safe everywhere (CLI, app bundled CLI, extension bundle).
//
// This script reads the .py and emits a TypeScript module exporting the full
// content as a JS template literal (backslashes, backticks and ${ escaped) plus
// a short content hash. Wired into `npm run build` so the generated file stays
// in sync with the .py. The generated file is ALSO committed so it is present
// without a build.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC_PY = path.join(REPO, 'media', 'gimp', 'gimp_mcp_server.py');
const OUT_TS = path.join(REPO, 'src', 'core', 'gimpPluginSource.ts');

const raw = fs.readFileSync(SRC_PY, 'utf8');
const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);

// Escape for a JS template literal: backslash first, then backtick, then ${ .
const escaped = raw
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const banner = `// ---------------------------------------------------------------------------
// gimpPluginSource.ts — GENERATED. Do not edit by hand.
//
// Source of truth: media/gimp/gimp_mcp_server.py (GPL-3.0; see media/gimp/LICENSE).
// Regenerate with:  node scripts/gen-gimp-plugin-source.mjs  (runs in \`npm run build\`).
//
// This embeds the auto-start GIMP MCP plugin body as a string so the installer
// works even when bundled (VS Code extension esbuild) with no media file on disk.
// ---------------------------------------------------------------------------
`;

const body =
  `${banner}\n` +
  `/** sha256 (first 12 hex) of the canonical media/gimp/gimp_mcp_server.py. */\n` +
  `export const GIMP_PLUGIN_SOURCE_HASH = ${JSON.stringify(hash)};\n\n` +
  `/** Full body of the auto-start GIMP 3.x MCP plugin (media/gimp/gimp_mcp_server.py). */\n` +
  `export const GIMP_PLUGIN_SOURCE = \`${escaped}\`;\n`;

fs.writeFileSync(OUT_TS, body);
process.stdout.write(`gen-gimp-plugin-source: wrote ${path.relative(REPO, OUT_TS)} (${raw.length} bytes, sha256:${hash})\n`);
