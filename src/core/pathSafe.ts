import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// pathSafe — workspace containment that also defeats symlink escapes.
//
// A purely lexical check (path.resolve + startsWith(root)) is not enough: a
// symlink that lives inside the workspace but points outside it (common after a
// git checkout, or created by the agent itself) passes the lexical test yet
// resolves to an arbitrary host file. resolveWithinRoot canonicalizes with
// fs.realpathSync — realpath'ing the nearest existing ancestor for create ops,
// whose leaf does not exist yet — and re-asserts containment against the real
// root before returning the path.
// ---------------------------------------------------------------------------

/**
 * Resolve `rel` against `root` and return the absolute path ONLY when it is
 * contained within `root` both lexically AND after resolving symlinks. Returns
 * null when the target escapes the workspace (including via a symlink that
 * lexically lives inside it).
 *
 * @param allowRoot when false, the root itself is rejected (used for mutations).
 */
export function resolveWithinRoot(root: string, rel: string, allowRoot: boolean): string | null {
  const resolved = path.resolve(root, rel);

  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = root; }

  if (resolved === root) { return allowRoot ? resolved : null; }
  // Lexical containment first (cheap, and rejects "../" traversal).
  if (!resolved.startsWith(root + path.sep)) { return null; }

  // Canonicalize the deepest existing ancestor — the leaf may not exist for a
  // create op (write/mkdir/rename target). Any symlink along the way is
  // resolved, so a link that points outside realRoot is rejected here.
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) { return null; }
    probe = parent;
  }
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { return null; }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) { return null; }

  return resolved;
}
