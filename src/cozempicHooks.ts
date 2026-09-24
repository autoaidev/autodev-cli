import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Cozempic hook reconciliation
// ---------------------------------------------------------------------------
// `cozempic init` INSTALLS its long-session guard/pruning hooks into
// `<root>/.claude/settings.local.json`. Each installed hook command contains the
// literal `cozempic` (and is tagged with a trailing `# cozempic-hook-schema=vN`
// comment). The shape is Claude Code's standard hooks map:
//
//   { "hooks": { "<Event>": [ { "matcher": "…", "hooks": [ { "type": "command",
//                                                            "command": "…" } ] } ] } }
//
// Making cozempic opt-in only STOPPED new installs — it never removed hooks a
// workspace already had wired. `removeCozempicHooks` is the reconcile side: it
// strips ONLY cozempic-tagged hook entries and leaves every other hook / setting
// intact. We strip directly rather than shelling out to `cozempic init --remove`
// / `cozempic uninstall` because cozempic is an optional external tool that may
// not be on PATH when the user unchecks the box, and the hooks are self-tagged —
// so a direct, dependency-free strip is the reliable, idempotent path.
// ---------------------------------------------------------------------------

/**
 * True when a hook entry's command is a cozempic-INSTALLED hook.
 *
 * Precise on purpose — a bare substring test on `cozempic` would false-positive
 * strip an unrelated hook that merely mentions the word (e.g. `echo not-cozempic`).
 * Every hook `cozempic init` writes carries the canonical `# cozempic-hook-schema=vN`
 * tag AND invokes the tool (`cozempic <subcommand>` or `python3 -m cozempic`); we
 * match those shapes so only cozempic's own hooks are removed.
 */
function _isCozempicCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') { return false; }
  return /cozempic-hook-schema=/.test(cmd)            // canonical install tag
    || /(^|[^\w-])cozempic\s/.test(cmd)               // invokes the cozempic binary
    || /-m\s+cozempic\b/.test(cmd);                   // invokes `python3 -m cozempic`
}

interface HookLeaf { type?: string; command?: string; [k: string]: unknown; }
interface HookGroup { matcher?: string; hooks?: HookLeaf[]; [k: string]: unknown; }

/**
 * Remove ONLY cozempic-tagged hook entries from a SINGLE settings file.
 *
 * - Idempotent and safe when the file, the `hooks` map, or any cozempic hooks are
 *   absent (returns false, writes nothing).
 * - Preserves every non-cozempic hook, matcher group, and all other settings.
 * - Prunes now-empty matcher groups and now-empty event arrays so no orphan
 *   `{ "matcher": "", "hooks": [] }` scaffolding lingers; drops the `hooks` key
 *   entirely if it ends up empty.
 * - Best-effort: never throws (a settings write failure must not break a rebuild);
 *   malformed JSON → skip the file untouched.
 *
 * @returns true if the file was changed, false otherwise.
 */
export function removeCozempicHooksFromFile(settingsPath: string): boolean {
  try {
    if (!settingsPath) { return false; }
    if (!fs.existsSync(settingsPath)) { return false; }

    const raw = fs.readFileSync(settingsPath, 'utf8');
    // Fast path — nothing to do if the file never mentions cozempic.
    if (!raw.includes('cozempic')) { return false; }

    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); } catch { return false; } // malformed — do not touch
    if (!data || typeof data !== 'object' || Array.isArray(data)) { return false; }

    const hooks = data.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) { return false; }

    let changed = false;

    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) { continue; }

      const keptGroups: HookGroup[] = [];
      for (const group of groups as HookGroup[]) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
          keptGroups.push(group);
          continue;
        }
        const keptLeaves = group.hooks.filter(leaf => !_isCozempicCommand(leaf?.command));
        if (keptLeaves.length !== group.hooks.length) { changed = true; }
        if (keptLeaves.length === 0) {
          // Whole matcher group was cozempic-only → drop it.
          changed = true;
          continue;
        }
        keptGroups.push({ ...group, hooks: keptLeaves });
      }

      if (keptGroups.length === 0) {
        delete hooks[event];
        changed = true;
      } else {
        hooks[event] = keptGroups;
      }
    }

    if (!changed) { return false; }

    // Drop an emptied hooks map so we leave a clean file.
    if (Object.keys(hooks).length === 0) {
      delete data.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    // A settings write failure must never break a profile rebuild / dispatch.
    return false;
  }
}

/**
 * Reconcile cozempic hooks out of EVERY settings file that could carry them.
 *
 * A user unchecking cozempic previously left the GLOBAL user settings
 * (`~/.claude/settings.json`) untouched, so a global cozempic SessionStart hook
 * kept firing (grok labels it "global/settings" and fails on Windows with
 * `exit code 1`). We now strip cozempic hooks from all three locations:
 *   1. `<root>/.claude/settings.local.json`  — project-local (install target)
 *   2. `<root>/.claude/settings.json`         — project shared settings
 *   3. `~/.claude/settings.json`              — GLOBAL user settings
 *
 * Each file is cleaned best-effort / no-throw / idempotently; non-existent or
 * malformed files are skipped. Returns true if ANY file was changed.
 */
export function removeCozempicHooks(root: string): boolean {
  const targets: string[] = [];
  if (root) {
    targets.push(path.join(root, '.claude', 'settings.local.json'));
    targets.push(path.join(root, '.claude', 'settings.json'));
  }
  try { targets.push(path.join(os.homedir(), '.claude', 'settings.json')); } catch { /* homedir unavailable */ }

  let changed = false;
  for (const p of targets) {
    // De-dupe: a root under HOME could collide with the global path.
    if (removeCozempicHooksFromFile(p)) { changed = true; }
  }
  return changed;
}
