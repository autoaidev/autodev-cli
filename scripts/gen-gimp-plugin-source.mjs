#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gen-gimp-plugin-source.mjs — generate the embedded GIMP source modules from
// the canonical vendored files:
//   media/gimp/gimp_mcp_server.py → src/core/gimpPluginSource.ts (GIMP_PLUGIN_SOURCE)
//   media/gimp/gimp_mcp_client.py → src/core/gimpClientSource.ts (GIMP_CLIENT_SOURCE)
//
// WHY: installGimpPlugin() must write BOTH the GIMP-side plug-in AND the MCP
// client. Reading media/*.py at runtime works in the CLI process (media/ ships in
// the tarball) but FAILS when this code is esbuild-bundled into the VS Code
// extension — there is no media file on disk at runtime. Embedding each body as a
// string constant makes the installer bundle-safe everywhere (CLI, app bundled
// CLI, extension bundle).
//
// Each generated file exports the full content as a JS template literal
// (backslashes, backticks and ${ escaped) plus a short content hash. Wired into
// `npm run build` (prebuild) so the generated files stay in sync with the .py.
// The generated files are ALSO committed so they are present without a build.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

/** Escape a raw string for embedding in a JS template literal. */
function escapeForTemplate(raw) {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Generate one embedded-source TS module from a vendored .py.
 *   srcRel  — path (relative to repo) of the source .py
 *   outRel  — path (relative to repo) of the generated .ts
 *   hashConst / sourceConst — exported identifier names
 *   whatIsIt — one-line human description for the banner + doc comment
 */
function gen({ srcRel, outRel, hashConst, sourceConst, whatIsIt }) {
  const srcPy = path.join(REPO, srcRel);
  const outTs = path.join(REPO, outRel);
  const raw = fs.readFileSync(srcPy, 'utf8');
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  const escaped = escapeForTemplate(raw);

  const banner = `// ---------------------------------------------------------------------------
// ${path.basename(outRel)} — GENERATED. Do not edit by hand.
//
// Source of truth: ${srcRel} (GPL-3.0; see media/gimp/LICENSE).
// Regenerate with:  node scripts/gen-gimp-plugin-source.mjs  (runs in \`npm run build\`).
//
// Embeds ${whatIsIt} as a string so the installer works even when bundled
// (VS Code extension esbuild) with no media file on disk.
// ---------------------------------------------------------------------------
`;

  const body =
    `${banner}\n` +
    `/** sha256 (first 12 hex) of the canonical ${srcRel}. */\n` +
    `export const ${hashConst} = ${JSON.stringify(hash)};\n\n` +
    `/** Full body of ${whatIsIt} (${srcRel}). */\n` +
    `export const ${sourceConst} = \`${escaped}\`;\n`;

  fs.writeFileSync(outTs, body);
  process.stdout.write(
    `gen-gimp-plugin-source: wrote ${outRel} (${raw.length} bytes, sha256:${hash})\n`);
}

gen({
  srcRel: path.join('media', 'gimp', 'gimp_mcp_server.py'),
  outRel: path.join('src', 'core', 'gimpPluginSource.ts'),
  hashConst: 'GIMP_PLUGIN_SOURCE_HASH',
  sourceConst: 'GIMP_PLUGIN_SOURCE',
  whatIsIt: 'the user-verified GIMP 3.x MCP server plug-in',
});

gen({
  srcRel: path.join('media', 'gimp', 'gimp_mcp_client.py'),
  outRel: path.join('src', 'core', 'gimpClientSource.ts'),
  hashConst: 'GIMP_CLIENT_SOURCE_HASH',
  sourceConst: 'GIMP_CLIENT_SOURCE',
  whatIsIt: 'the user-verified GIMP MCP client (FastMCP stdio)',
});
