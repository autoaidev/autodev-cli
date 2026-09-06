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
//   - gimp    : the ONE thing we never clobber is a user's concrete local client
//               (python[3] <path>, or `uv run … <concrete local path>`). Anything
//               else — the old <…> placeholder stub, OR the BROKEN raw-github
//               upstream client (raw.githubusercontent.com/…/gimp_mcp_client.py)
//               — is upgraded to `uv run --with mcp==1.2.0 <LOCAL client path>`
//               using the client installGimpPlugin() writes on this machine. If
//               GIMP is not installed we can't compute that path, so we leave the
//               entry as-is (we never NEWLY write the broken raw URL).
// `enabled`, `env`, and `_meta` are preserved; the match is name-based so entries
// written before any `_meta.catalogId` tag existed still migrate. Non-creative
// entries (built-ins, filesystem's <ALLOWED_DIR>, custom user servers) are never
// touched. Idempotent: an entry already equal to the catalog spec is left alone.
// ---------------------------------------------------------------------------

import { serverSpecFor, gimpClientArgOf, isConcreteGimpClientArg, type CreativeAppId } from './mcpCatalog';
import { resolveGimpClientPath } from './gimpPluginInstall';
import { loadProjectUserMcp, saveProjectUserMcp, type McpJsonEntry, type McpJsonEntries } from './projectMcp';

/** Creative catalog ids we re-resolve (single source: mcpCatalog). */
const CREATIVE_IDS: CreativeAppId[] = ['blender', 'gimp'];

export interface MigrateOpts {
  /**
   * Resolve the local gimp client path for this machine, or null when GIMP 3.x is
   * absent. Defaults to resolveGimpClientPath() (real detection). Injectable for
   * tests. When null, a gimp entry that needs upgrading is left as-is.
   */
  resolveGimpClient?: () => string | null;
}

function _argsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) { if (aa[i] !== bb[i]) return false; }
  return true;
}

/**
 * A gimp entry the migration must PRESERVE: it already points at a CONCRETE local
 * client (a real filesystem path, not the placeholder and not a URL) — either a
 * user's own checkout or the client we already installed. Everything else (the
 * placeholder stub, the broken raw-github URL, or a bare command) is upgradeable.
 */
function _isGimpConcreteLocal(e: McpJsonEntry): boolean {
  return isConcreteGimpClientArg(gimpClientArgOf(e));
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
  opts?: MigrateOpts,
): boolean {
  const resolveGimpClient = opts?.resolveGimpClient ?? (() => resolveGimpClientPath());

  let userMcp: McpJsonEntries;
  try { userMcp = loadProjectUserMcp(root); } catch { return false; }

  let changed = false;
  for (const id of CREATIVE_IDS) {
    const entry = userMcp[id];
    if (!entry) continue;
    // Only stdio creative entries can match a catalog spec — a remote (url) entry
    // under this name is not ours to touch.
    if (typeof entry.command !== 'string') continue;

    let spec: McpJsonEntry;
    if (id === 'gimp') {
      // Never clobber a user's concrete local client (or the one we installed).
      if (_isGimpConcreteLocal(entry)) continue;
      // Otherwise (placeholder stub / broken raw-github URL / bare command) upgrade
      // to the locally-installed client — but only if we can resolve one. Without a
      // detected GIMP we leave the entry as-is (never NEWLY write the broken URL).
      const clientPath = resolveGimpClient();
      if (!clientPath) continue;
      spec = serverSpecFor('gimp', platform, { gimpClientPath: clientPath });
    } else {
      spec = serverSpecFor(id, platform);
    }

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
      : 'ConfigManager: migrated gimp MCP server to the locally-installed client (uv run)');
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
