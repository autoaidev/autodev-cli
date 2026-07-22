import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from './pathSafe';

// ---------------------------------------------------------------------------
// projectSkills — receive side of the "Skills management" feature.
//
// pixel-office pushes an agent's FULL effective Claude Code Agent Skill set over
// the WS channel (`skill_update` frame). This module validates that untrusted
// payload and writes each skill to `<root>/.claude/skills/<slug>/SKILL.md` so a
// running Claude Code agent picks it up live (Claude re-reads skills each run —
// no restart needed).
//
// Two safety layers, mirroring projectMcp:
//   1. sanitizeRemoteSkills — strict validation: slug shape (^[a-z0-9][a-z0-9-]*$),
//      string description/body, per-file body cap, total count + total bytes caps,
//      and resolveWithinRoot path containment (defeats ../ traversal AND symlink
//      escape). Rejected entries are reported, not written.
//   2. saveProjectSkills — FULL-REPLACE write. A manifest at
//      `.autodev/synced-skills.json` records the slugs THIS sync owns, so a
//      full-replace only removes skills we previously wrote — never the
//      CLI-bundled skills (from applyAllSkills / media/skills) or user hand-made
//      ones.
//
// Providers that cannot load SKILL.md (opencode/grok/copilot) get a best-effort
// prose fold instead — see foldSkillsIntoProfile.
// ---------------------------------------------------------------------------

export interface RemoteSkill {
  /** Skill slug — the directory name under .claude/skills/. */
  name: string;
  /** One-line description (goes into SKILL.md frontmatter). */
  description: string;
  /** Instructions markdown WITHOUT frontmatter. */
  body: string;
}

export type SafeSkill = RemoteSkill;

export interface RejectedSkill { name: string; reason: string; }

// A skill slug is a plain directory name: lowercase alnum + hyphen only. No
// separators, no dots — this alone rejects "../evil", "a/b", ".hidden", etc.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Caps — the whole point of the sanitizer. Keep them strict.
const MAX_SKILLS       = 100;              // total number of skills per sync
const MAX_NAME_LEN     = 64;               // slug length
const MAX_DESC_BYTES   = 4 * 1024;         // 4 KB per description
const MAX_BODY_BYTES   = 64 * 1024;        // 64 KB per body
const MAX_TOTAL_BYTES  = 4 * 1024 * 1024;  // 4 MB across all skills

const SKILLS_REL_DIR   = path.posix.join('.claude', 'skills');
const MANIFEST_REL     = path.join('.autodev', 'synced-skills.json');

/** True for providers that natively load `.claude/skills/<slug>/SKILL.md` (Claude only). */
export function providerConsumesSkills(provider: string | undefined): boolean {
  return provider === 'claude-cli' || provider === 'claude-tui';
}

/**
 * Validate an untrusted `skills` array (from a `skill_update` frame) down to the
 * subset that is safe to write. Enforces slug shape, string types, per-file and
 * aggregate size caps, a total count cap, and workspace path containment.
 * Returns the accepted list (in order) plus the rejected entries with reasons.
 * Callers must still gate the whole path behind an opt-in (skillUpdateEnabled).
 */
export function sanitizeRemoteSkills(
  root: string,
  skills: unknown,
): { safe: SafeSkill[]; rejected: RejectedSkill[] } {
  const safe: SafeSkill[] = [];
  const rejected: RejectedSkill[] = [];
  if (!Array.isArray(skills)) { return { safe, rejected }; }

  const seen = new Set<string>();
  let totalBytes = 0;

  for (const raw of skills) {
    const entry = raw as Partial<RemoteSkill> | undefined;
    const rawName = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const label = rawName || '(unnamed)';

    if (!entry || typeof entry !== 'object') { rejected.push({ name: label, reason: 'not an object' }); continue; }
    if (!SKILL_NAME_RE.test(rawName)) { rejected.push({ name: label, reason: 'invalid slug (must match ^[a-z0-9][a-z0-9-]*$)' }); continue; }
    if (rawName.length > MAX_NAME_LEN) { rejected.push({ name: label, reason: 'slug too long' }); continue; }
    if (seen.has(rawName)) { rejected.push({ name: rawName, reason: 'duplicate slug' }); continue; }
    if (typeof entry.description !== 'string') { rejected.push({ name: rawName, reason: 'description not a string' }); continue; }
    if (typeof entry.body !== 'string') { rejected.push({ name: rawName, reason: 'body not a string' }); continue; }

    const descBytes = Buffer.byteLength(entry.description, 'utf8');
    const bodyBytes = Buffer.byteLength(entry.body, 'utf8');
    if (descBytes > MAX_DESC_BYTES) { rejected.push({ name: rawName, reason: `description too large (${descBytes} > ${MAX_DESC_BYTES})` }); continue; }
    if (bodyBytes > MAX_BODY_BYTES) { rejected.push({ name: rawName, reason: `body too large (${bodyBytes} > ${MAX_BODY_BYTES})` }); continue; }

    // Path-safety: the composed target must resolve INSIDE the workspace, even
    // after symlink resolution. (The slug regex already blocks ../ and /, this
    // is belt-and-suspenders + symlink defence.)
    const target = resolveWithinRoot(root, path.posix.join(SKILLS_REL_DIR, rawName, 'SKILL.md'), false);
    if (!target) { rejected.push({ name: rawName, reason: 'path escapes workspace' }); continue; }

    if (safe.length >= MAX_SKILLS) { rejected.push({ name: rawName, reason: `over skill count cap (${MAX_SKILLS})` }); continue; }
    if (totalBytes + descBytes + bodyBytes > MAX_TOTAL_BYTES) { rejected.push({ name: rawName, reason: `over total bytes cap (${MAX_TOTAL_BYTES})` }); continue; }

    totalBytes += descBytes + bodyBytes;
    seen.add(rawName);
    safe.push({ name: rawName, description: entry.description, body: entry.body });
  }

  return { safe, rejected };
}

/** Compose the on-disk SKILL.md (frontmatter + body). Description newlines are
 *  collapsed to keep the YAML frontmatter valid. */
function _composeSkillFile(s: SafeSkill): string {
  const desc = s.description.replace(/[\r\n]+/g, ' ').trim();
  const body = s.body.replace(/\s+$/, '');
  return `---\nname: ${s.name}\ndescription: ${desc}\n---\n\n${body}\n`;
}

function _readManifest(root: string): string[] {
  try {
    const f = path.join(root, MANIFEST_REL);
    if (!fs.existsSync(f)) { return []; }
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function _writeManifest(root: string, slugs: string[]): void {
  const f = path.join(root, MANIFEST_REL);
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(f, JSON.stringify(slugs, null, 2) + '\n', 'utf8');
}

/**
 * Write the supplied (already-sanitized) skills to `<root>/.claude/skills/<slug>/SKILL.md`
 * as a FULL REPLACE: every previously-synced skill (tracked in the manifest) that
 * is NOT in the new set is removed, and its now-empty dir pruned. Skills we did
 * not write (CLI-bundled via applyAllSkills, or user hand-made) are never touched.
 * Returns the slugs written and removed.
 */
export function saveProjectSkills(
  root: string,
  safeSkills: SafeSkill[],
): { written: string[]; removed: string[] } {
  const prev = _readManifest(root);
  const nextSet = new Set(safeSkills.map(s => s.name));
  const written: string[] = [];
  const removed: string[] = [];

  // Write / overwrite each safe skill.
  for (const s of safeSkills) {
    const target = resolveWithinRoot(root, path.posix.join(SKILLS_REL_DIR, s.name, 'SKILL.md'), false);
    if (!target) { continue; } // defensive — sanitizer already validated
    try {
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(target, _composeSkillFile(s), 'utf8');
      written.push(s.name);
    } catch { /* ignore individual write errors */ }
  }

  // Remove previously-synced skills that are gone from the new set — but ONLY
  // ones we own (in the manifest), never bundled or hand-made skills.
  for (const slug of prev) {
    if (nextSet.has(slug)) { continue; }
    if (!SKILL_NAME_RE.test(slug)) { continue; } // defensive
    const target = resolveWithinRoot(root, path.posix.join(SKILLS_REL_DIR, slug, 'SKILL.md'), false);
    if (!target) { continue; }
    try {
      if (fs.existsSync(target)) { fs.unlinkSync(target); }
      const dir = path.dirname(target);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); }
      removed.push(slug);
    } catch { /* ignore */ }
  }

  _writeManifest(root, written);
  return { written, removed };
}

// ---------------------------------------------------------------------------
// Prose fold — for non-Claude providers (opencode/grok/copilot) that cannot
// load SKILL.md, fold a short managed "## Skills" section into AGENTS.md so
// those agents still benefit. Idempotent: replaces a marker block, never
// appends forever. Passing an empty list removes the block.
// ---------------------------------------------------------------------------

const SKILLS_FOLD_BEGIN = '<!-- autodev:skills:begin -->';
const SKILLS_FOLD_END   = '<!-- autodev:skills:end -->';
const SKILLS_FOLD_RE    = /\n*<!-- autodev:skills:begin -->[\s\S]*?<!-- autodev:skills:end -->\n*/;

/**
 * Fold the given skills into a managed "## Skills" block in `<root>/AGENTS.md`
 * (best-effort, idempotent). Non-Claude agents read AGENTS.md but cannot load
 * `.claude/skills`, so this is how they gain the skill instructions. An empty
 * list strips the block.
 */
export function foldSkillsIntoProfile(root: string, safeSkills: SafeSkill[]): void {
  if (!root) { return; }
  const target = path.join(root, 'AGENTS.md');

  let block = '';
  if (safeSkills.length > 0) {
    const parts = safeSkills.map(s => {
      const desc = s.description.replace(/[\r\n]+/g, ' ').trim();
      return `### ${s.name}\n\n${desc}\n\n${s.body.trim()}`;
    });
    block = `${SKILLS_FOLD_BEGIN}\n\n## Skills\n\n${parts.join('\n\n')}\n\n${SKILLS_FOLD_END}`;
  }

  let content = '';
  try { if (fs.existsSync(target)) { content = fs.readFileSync(target, 'utf8'); } } catch { /* treat as empty */ }

  if (SKILLS_FOLD_RE.test(content)) {
    content = content.replace(SKILLS_FOLD_RE, block ? `\n\n${block}\n` : '\n');
  } else if (block) {
    content = content ? `${content.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`;
  } else {
    return; // nothing to add, nothing to strip
  }

  try { fs.writeFileSync(target, content, 'utf8'); } catch { /* best-effort */ }
}
