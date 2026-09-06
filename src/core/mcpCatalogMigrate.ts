// ---------------------------------------------------------------------------
// mcpCatalogMigrate — auto-upgrade stale creative-app MCP entries in .mcp.json.
//
// When a creative-app server (Blender / GIMP) was enabled BEFORE the catalog was
// corrected, the OLD spec got snapshotted into the agent's `.mcp.json` as a user
// entry. `syncProjectMcpServers` then fans that stale entry out to every provider
// config verbatim — so the user keeps getting the broken command after updating.
//
// This migration RE-RESOLVES creative-app user entries from the CURRENT catalog
// (`serverSpecFor`) so the fixed command reaches every provider on the next sync.
// It is deliberately narrow:
//   - blender : ALWAYS re-resolved if command/args drift from the catalog spec
//               (Blender has no user-customizable fields, so replacing is safe).
//   - gimp    : re-resolved to the git-based `uv run …` spec if the stored entry
//               drifts from the current catalog (covers the OLD <GIMP_MCP_CLIENT_PY>
//               placeholder stub AND any earlier command). The ONE thing we never
//               clobber is a user's LOCAL checkout: a python/python3 entry pointing
//               at a concrete (non-placeholder) client path is preserved.
// `enabled`, `env`, and `_meta` are preserved; the match is name-based so entries
// written before any `_meta.catalogId` tag existed still migrate. Non-creative
// entries (built-ins, filesystem's <ALLOWED_DIR>, custom user servers) are never
// touched. Idempotent: an entry already equal to the catalog spec is left alone.
// ---------------------------------------------------------------------------

import { serverSpecFor, GIMP_CLIENT_PLACEHOLDER, type CreativeAppId } from './mcpCatalog';
import { loadProjectUserMcp, saveProjectUserMcp, type McpJsonEntry, type McpJsonEntries } from './projectMcp';

/** Creative catalog ids we re-resolve (single source: mcpCatalog). */
const CREATIVE_IDS: CreativeAppId[] = ['blender', 'gimp'];

function _argsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) { if (aa[i] !== bb[i]) return false; }
  return true;
}

/**
 * A gimp entry the migration must PRESERVE: a user's local checkout, i.e. a
 * python/python3 command pointing at a concrete (non-placeholder) client path.
 * Everything else (the old <GIMP_MCP_CLIENT_PY> placeholder stub, or any earlier
 * command form) is upgradeable to the current git-based catalog spec.
 */
function _isGimpLocalPython(e: McpJsonEntry): boolean {
  if (e.command !== 'python' && e.command !== 'python3') { return false; }
  const first = Array.isArray(e.args) ? e.args[0] : undefined;
  return typeof first === 'string' && first.length > 0 && first !== GIMP_CLIENT_PLACEHOLDER;
}

/**
 * Re-resolve stale creative-app user entries in <root>/.mcp.json from the current
 * catalog. Persists the upgraded set back to .mcp.json when anything changed and
 * logs each upgrade. Returns true iff at least one entry was migrated.
 */
export function migrateCreativeMcpEntries(
  root: string,
  platform: NodeJS.Platform,
  log?: (m: string) => void,
): boolean {
  let userMcp: McpJsonEntries;
  try { userMcp = loadProjectUserMcp(root); } catch { return false; }

  let changed = false;
  for (const id of CREATIVE_IDS) {
    const entry = userMcp[id];
    if (!entry) continue;
    // Only stdio creative entries can match a catalog spec — a remote (url) entry
    // under this name is not ours to touch.
    if (typeof entry.command !== 'string') continue;
    // GIMP: never clobber a user's local checkout (python[3] + real client path);
    // everything else (old placeholder stub / earlier command) upgrades below.
    if (id === 'gimp' && _isGimpLocalPython(entry)) continue;

    const spec = serverSpecFor(id, platform);
    // Idempotent — already the catalog spec, nothing to do.
    if (entry.command === spec.command && _argsEqual(entry.args, spec.args)) continue;

    // Replace command + args from the catalog; PRESERVE enabled/env/_meta and any
    // other user-added fields (saveProjectUserMcp re-normalizes + keeps enabled/env).
    entry.command = spec.command;
    entry.args = spec.args ?? [];
    // Tag it so future catalog changes are unambiguously re-resolvable.
    entry._meta = { ...(entry._meta || {}), catalogId: id };

    changed = true;
    log?.(id === 'blender'
      ? 'ConfigManager: migrated blender MCP server to the Blender Lab client'
      : 'ConfigManager: migrated gimp MCP server to the git-based uv run client');
  }

  if (changed) {
    try {
      saveProjectUserMcp(root, userMcp);
    } catch (e) {
      log?.(`ConfigManager: failed persisting creative MCP migration: ${e}`);
      return false;
    }
  }
  return changed;
}
