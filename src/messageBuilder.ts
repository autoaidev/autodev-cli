import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from './todo';
import { autodevDir } from './sessionState';
import { applyProtocolSections, applyMcpSkills, applyAllSkills } from './protocolSections';
import { assembleProfileBody } from './profileBuilder';
import { loadSettingsForRoot } from './core/settingsLoader';
import { ensureSoulSkeleton } from './connect';
import { removeCozempicHooks } from './cozempicHooks';

// ---------------------------------------------------------------------------
// File path constants — all files live under <workspace>/.autodev/
// ---------------------------------------------------------------------------

/** Agent profile instructions written for each task run */
// The single master reference. AGENTS.md / CLAUDE.md point ONLY here; this file
// (autoresearch-style "program") describes every other reference — the profile
// sections, the control spec, and the auto-mode loop tools. Uppercase to match the
// other agent docs (AGENTS.md / CLAUDE.md / SOUL.md).
export const AGENT_PROFILE_FILE = '.autodev/PROGRAM.md';
// Older profile-index names we migrate away from so only PROGRAM.md remains:
// AGENT_PROFILE.md (the original flat index) and program.md (the lowercase interim
// name). rebuildProfile removes any that exist — with a realpath guard so a
// case-insensitive FS (where program.md IS PROGRAM.md) never deletes the live file.
const LEGACY_PROFILE_FILES = ['.autodev/AGENT_PROFILE.md', '.autodev/program.md'];

/** Directory where per-task message files are stored */
export const MESSAGES_DIR = '.autodev/messages';

/** Directory where attachments are saved, grouped by timestamp+hash */
export const ATTACHMENTS_DIR = '.autodev/messages/attachments';

// Marker pair used to identify the autodev-managed block in CLAUDE.md / AGENTS.md
const AGENT_REF_BEGIN = '<!-- autodev:profile-ref:begin -->';
const AGENT_REF_END   = '<!-- autodev:profile-ref:end -->';

/**
 * Ensure `CLAUDE.md` and `AGENTS.md` in `root` contain an import reference
 * to `.autodev/AGENT_PROFILE.md` inside autodev marker tags.
 * Idempotent — replaces the existing block on every rebuild.
 * Creates the file with just the reference block if it doesn't exist yet.
 */
function injectAgentProfileRef(root: string, _sectionPaths: string[] = []): void {
  // BOTH AGENTS.md and CLAUDE.md reference ONLY program.md now. program.md is the
  // master index that describes every other reference (the profile sections, the
  // control spec, the loop tools) — so the block stays one line even as sections
  // grow, and a small-context model loads just the index, then only what it needs.
  const markerRe = /<!-- autodev:profile-ref:begin -->[\s\S]*?<!-- autodev:profile-ref:end -->/;
  // SOUL.md (identity anchor) is referenced DIRECTLY here — ahead of program.md —
  // so the agent loads who it is first; program.md is the master protocol index and
  // also links SOUL.md. Identity must not be buried one hop behind the index.
  const block = [
    AGENT_REF_BEGIN,
    `file://./SOUL.md`,
    `file://./${AGENT_PROFILE_FILE.replace(/\\/g, '/')}`,
    `<think>`,
    `IMPORTANT: Read SOUL.md FIRST — it is your identity anchor (your name, any assigned persona, and your communication history). Then read \`.autodev/PROGRAM.md\`, the master index that describes and links every AutoDev reference (profile sections, control spec, loop tools). Load the referenced files on demand as the task needs them.`,
    `</think>`,
    AGENT_REF_END,
  ].join('\n');

  for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(root, filename);
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }
    if (markerRe.test(content)) {
      content = content.replace(markerRe, block);
    } else {
      // Prepend block — agents read the top of the file first
      content = block + (content ? '\n\n' + content : '');
    }
    fs.writeFileSync(filePath, content, 'utf8');
  }

  // Migrate away from older index names so only PROGRAM.md remains. Guard so we
  // NEVER delete the canonical PROGRAM.md we just wrote. Two layers:
  //   1. Case-INSENSITIVE resolved-path compare (Windows fix). On a case-insensitive
  //      FS `.autodev/program.md` IS `.autodev/PROGRAM.md`, but fs.realpathSync
  //      returns the REQUESTED case, so the realpath === compare below misses the
  //      collision and rmSync('.autodev/program.md') deletes the live index — the
  //      recurring "PROGRAM.md missing on Windows" bug. isCanonicalProfileCollision
  //      lowercases both resolved paths so program.md is skipped there.
  //   2. realpath === compare — the secondary guard for genuinely-distinct files
  //      on a case-sensitive FS (Linux), where a stray lowercase program.md is a
  //      DIFFERENT file and is safe to remove.
  // Best-effort; ignore if absent.
  let currentReal: string | null = null;
  try { currentReal = fs.realpathSync(path.join(root, AGENT_PROFILE_FILE)); } catch { currentReal = null; }
  for (const legacy of LEGACY_PROFILE_FILES) {
    try {
      const p = path.join(root, legacy);
      if (!fs.existsSync(p)) { continue; }
      if (isCanonicalProfileCollision(root, legacy)) { continue; } // case-insensitive: same file as PROGRAM.md
      if (currentReal && fs.realpathSync(p) === currentReal) { continue; } // same file (case-sensitive FS)
      fs.rmSync(p);
    } catch { /* best effort */ }
  }
}

/**
 * True when a legacy profile-index candidate resolves to the SAME path as the
 * canonical `.autodev/PROGRAM.md`, compared case-INSENSITIVELY. On a
 * case-insensitive FS (Windows) `.autodev/program.md` and `.autodev/PROGRAM.md`
 * are one file, yet `fs.realpathSync` echoes back the requested case so a plain
 * `===` realpath compare misses the collision and the legacy cleanup deletes the
 * live index. Lowercasing both resolved paths closes that gap. The only
 * case-colliding legacy entry is `program.md`; `AGENT_PROFILE.md` never collides.
 * Exported for the collision unit test.
 */
export function isCanonicalProfileCollision(root: string, legacyRel: string): boolean {
  return path.resolve(root, legacyRel).toLowerCase()
    === path.resolve(root, AGENT_PROFILE_FILE).toLowerCase();
}

const COPILOT_INSTRUCTIONS_FILE = '.github/copilot-instructions.md';
const COPILOT_BEGIN = '<!-- autodev:profile:begin -->';
const COPILOT_END   = '<!-- autodev:profile:end -->';

/**
 * Sync the assembled profile body into `.github/copilot-instructions.md`.
 * GitHub Copilot cannot follow `@`-import references, so the content is
 * written inline, wrapped in idempotent autodev marker tags.
 * The file is created (including the `.github/` directory) if absent.
 */
function syncCopilotInstructions(root: string, _profileBody: string): void {
  // GitHub Copilot cannot follow @-import references, but the full profile is
  // already maintained in CLAUDE.md. Keep copilot-instructions.md as a slim
  // one-liner so there is no duplication to maintain.
  const refLine = 'See `AGENTS.md` in the project root for full agent instructions (AGENTS.md is the primary file; CLAUDE.md redirects to it).';
  const block = `${COPILOT_BEGIN}\n${refLine}\n${COPILOT_END}`;
  const markerRe = /<!-- autodev:profile:begin -->[\s\S]*?<!-- autodev:profile:end -->/;

  const githubDir = path.join(root, '.github');
  if (!fs.existsSync(githubDir)) {
    fs.mkdirSync(githubDir, { recursive: true });
  }

  const filePath = path.join(root, COPILOT_INSTRUCTIONS_FILE);
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  }
  if (markerRe.test(content)) {
    content = content.replace(markerRe, block);
  } else {
    content = block + (content ? '\n\n' + content : '');
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface ProfileMeta {
  title?: string;
  description?: string;
  /** When true, the task instruction omits the commit step */
  noCommit?: boolean;
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Returns metadata and the body with frontmatter stripped.
 */
export function parseFrontmatter(content: string): { meta: ProfileMeta; body: string } {
  // A profile pillar may carry a one-line "> **Digest:** …" blockquote prepended
  // as its first bytes (a front-loaded core directive for truncated ~200-char
  // reads). Skip it so any YAML frontmatter that follows is still detected/parsed.
  if (content.startsWith('> **Digest:**')) {
    const nl = content.indexOf('\n');
    content = nl === -1 ? '' : content.slice(nl + 1).replace(/^\r?\n/, '');
  }
  if (!content.startsWith('---')) {
    return { meta: {}, body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: content };
  }
  const block = content.slice(3, end).trim();
  const body = content.slice(end + 4).trimStart();
  const meta: ProfileMeta = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (!m) { continue; }
    const [, key, val] = m;
    const clean = val.replace(/^"|"$/g, '');
    if (key === 'title') { meta.title = clean; }
    if (key === 'description') { meta.description = clean; }
    if (key === 'noCommit') { meta.noCommit = clean === 'true'; }
  }
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------



/**
 * First-turn system reminder pointing the agent at the master protocol index
 * (`.autodev/program.md`) and its persistent identity anchor (`SOUL.md`).
 *
 * Gated on existence: returns '' when `.autodev/program.md` is absent (e.g. the
 * user deleted it) so we never emit a broken pointer. This is belt-and-suspenders
 * on top of the passive AGENTS.md / CLAUDE.md reference — it is meant to be
 * injected only on the FIRST turn of a session/loop (see buildMessage's
 * `includeProfile` gate), not repeated every turn.
 *
 * Exported so smoke tests can prove the existence gate directly.
 */
export function firstTurnSystemReminder(root: string): string {
  const programPath = path.join(root, AGENT_PROFILE_FILE);
  if (!fs.existsSync(programPath)) { return ''; }
  return [
    '<system-reminder>',
    'Before doing anything else, read `.autodev/PROGRAM.md` first — it is the master',
    'index of your protocols, tools, and references (load the linked sections on demand).',
    'Your identity and any assigned persona (name, role, e.g. a design persona) live in',
    '`SOUL.md`, your persistent identity anchor — read it too. PROGRAM.md is regenerated',
    'on every rebuild, so identity is never stored there; SOUL.md persists across rebuilds.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * Re-read-on-update reminder for SOUL.md (the agent's identity/persona anchor).
 *
 * The office can edit an agent's SOUL.md live (via the mcp-operate file browser, or
 * a persona change on connect). This fires a `<system-reminder>` on ANY turn whose
 * SOUL.md mtime advanced past the last one we recorded — so an identity edit made
 * mid-session is actually adopted, not ignored until the next fresh session.
 *
 * State is a tiny `.autodev/.soul-seen` marker (last-seen mtime). The FIRST time we
 * see a SOUL.md (no marker yet) we only record it and stay silent — the first-turn
 * reminder already tells the agent to read SOUL.md, and connect-time persona writes
 * must not trigger a spurious "it changed" on turn 1. Best-effort; never throws.
 */
export function soulUpdatedReminder(root: string): string {
  try {
    const soulPath = path.join(root, 'SOUL.md');
    if (!fs.existsSync(soulPath)) { return ''; }
    const mtime = Math.floor(fs.statSync(soulPath).mtimeMs);
    const marker = path.join(root, '.autodev', '.soul-seen');
    let last = 0;
    try { last = parseInt(fs.readFileSync(marker, 'utf8').trim(), 10) || 0; } catch { last = 0; }
    if (mtime !== last) {
      try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, String(mtime), 'utf8'); } catch { /* best effort */ }
    }
    // No prior marker → first observation this session: record, stay silent.
    if (last === 0 || mtime <= last) { return ''; }
    return [
      '<system-reminder>',
      'Your `SOUL.md` was just UPDATED (edited from the office). Re-read `SOUL.md` now and adopt the',
      'updated identity/persona/communication-history for this turn and all following turns.',
      '</system-reminder>',
    ].join('\n');
  } catch { return ''; }
}

/**
 * Resumed-session override reminder (per-turn).
 *
 * On a RESUMING provider/turn (grok-cli / grok-tui always; any other provider when
 * `resumeSession` is on) PAST the first turn, the agent's `SOUL.md` identity and
 * `.autodev/PROGRAM.md` protocol are ALREADY in the live conversation — the
 * provider carried them forward. The standing profile pillars ("Read SOUL.md
 * before every message", "Read SOUL.md FIRST") are written for STATELESS providers
 * that get a fresh context each turn; on a resumed turn they make the agent open
 * every turn by redundantly re-reading identity+protocol it already holds, which
 * both wastes the turn's opening and makes the user think resume is a no-op
 * ("seems session is not resuming, it always reads its profile").
 *
 * This reminder OVERRIDES the standing re-read for THIS turn only. It is NEVER
 * emitted on turn 1 (identity genuinely must load) and is suppressed when SOUL.md
 * actually changed this turn (soulUpdatedReminder wins → a real re-read). It is
 * purely additive: stateless providers and first turns still get their pillars.
 *
 * Exported so smoke tests can assert the override text directly.
 */
export function resumedSessionReminder(_root: string): string {
  return [
    '<system-reminder>',
    'You are CONTINUING your existing session — your `SOUL.md` identity and',
    '`.autodev/PROGRAM.md` protocol are ALREADY loaded in this conversation. Do NOT',
    're-read them or restate your identity/protocol; continue directly with the task.',
    'Re-read a file only if a reminder tells you it changed, or you actually need a',
    'specific reference for the work.',
    '</system-reminder>',
  ].join('\n');
}

/** Returns the .autodev/messages directory, creating it if needed. */
function messagesDir(root: string): string {
  const dir = path.join(root, MESSAGES_DIR);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return dir;
}

/** Generates a timestamp string like 20250410_143022 for use in filenames. */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Save an attachment to `.autodev/messages/attachments/<groupId>/filename`.
 * If `groupId` is omitted a new `<timestamp>_<hex>` folder is created.
 * Returns the workspace-relative forward-slash path (suitable for embedding in .md).
 */
export function saveAttachment(
  workspaceRoot: string,
  filename: string,
  data: Buffer | string,
  groupId?: string,
): string {
  // Reduce group + filename to leaf names and strip leading dots/whitespace so a
  // fully attacker-controlled attachment name can't escape the attachments dir
  // (e.g. "../../../../home/autodev/.bashrc" or "../../.ssh/authorized_keys").
  const rawGroup = groupId ?? `${timestamp()}_${crypto.randomBytes(4).toString('hex')}`;
  const safeGroup = path.basename(rawGroup).replace(/^[.\s]+/, '')
    || `${timestamp()}_${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(workspaceRoot, ATTACHMENTS_DIR, safeGroup);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  const safeName = path.basename(filename).replace(/^[.\s]+/, '') || 'attachment';
  const filePath = path.join(dir, safeName);
  // Belt-and-suspenders containment check — never write outside the attachments dir.
  const resolvedDir = path.resolve(dir);
  if (path.resolve(filePath) !== path.join(resolvedDir, safeName)
    || !path.resolve(filePath).startsWith(resolvedDir + path.sep)) {
    throw new Error('saveAttachment: refusing to write outside attachments directory');
  }
  if (Buffer.isBuffer(data)) {
    fs.writeFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, data, 'utf8');
  }
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

/**
 * Write arbitrary content to a timestamped message file and return the full path.
 * Used for reminder/check-in messages that bypass buildMessage().
 */
export function writeMessageFile(root: string, content: string): string {
  const dir = messagesDir(root);
  const filePath = path.join(dir, `MESSAGE_${timestamp()}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function readOrEmpty(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch { return ''; }
}

function buildTaskInstruction(task: Task, todoPath: string, root: string, noCommit = false): string {
  const date = new Date().toISOString().slice(0, 10);
  // Full raw task marker line as it appears (or will appear) in TODO.md
  const taskId   = task.id ? `[${task.id}] ` : '';
  const taskLine = `- [ ] ${taskId}${task.text}`;
  const doneLine = `- [x] ${date}  ${taskId}${task.text}`;
  // Relative file:// URI for the profile — works regardless of absolute workspace location.
  const profileRef = `@file://./${AGENT_PROFILE_FILE}`;

  // Inline attachment files from task.attachments (populated at parse time by todo.ts).
  // Only .md files are inlined as text — binary attachments (images, PDFs, etc.)
  // are listed in the header reference but not embedded.
  const inlinedFiles: string[] = [];
  for (const relPath of task.attachments ?? []) {
    if (!relPath.toLowerCase().endsWith('.md')) { continue; }
    const absPath = path.join(root, relPath);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath, 'utf8').trim();
        inlinedFiles.push(`### Attachment: ${path.basename(absPath)}\n\n${content}`);
      } catch { /* skip unreadable files */ }
    }
  }
  const inlinedSection = inlinedFiles.length > 0
    ? `\n---\n\n## Message Content (inlined — do not try to open the file)\n\n${inlinedFiles.join('\n\n---\n\n')}\n`
    : '';

  const attachmentRef = task.attachments && task.attachments.length > 0
    ? `**Attachments:** ${task.attachments.map(p => `\`${p}\``).join(', ')}\n`
    : '';

  return `> **NEXT TASK TO BEGIN, DO NOT STOP WORK**
  
## Current task

**Task ID:** \`${taskId.trim() || '(no id)'}\`
**Task text:** ${task.text}
**TODO.md:** \`${todoPath}\`  line ${task.line}
${attachmentRef}
see in 
> **IMPORTANT:** Even if you have done a similar task before, this is a **new independent task** that requires real work. Do NOT just mark it done — actually complete the task fully.

### Steps required

1. Open \`${todoPath}\` and find line ${task.line}:
   \`${taskLine}\`
2. Mark it in-progress **before** starting: change \`[ ]\` to \`[~]\`
3. **Actually do the work** described by the task text above. Follow all protocol instructions from your agent profile. 
 3.1 Discover the real task by opening the attachment files related to the todo entry, which are part of the task instructions. The files are listed above and may include important context, data, or subtasks. They are embedded in the message for your convenience, so read them carefully.
4. When the work is fully done, mark it complete:
   \`${doneLine}\`
5. Continue to the next \`[ ]\` task in \`${todoPath}\` — do not stop until all tasks are done.

> This loop runs continuously. Each task dispatch is a fresh task. "Standing by" or "already done" is not acceptable — complete the work.

---

**Full protocol and agent instructions:** ${profileRef}
${inlinedSection}`;
}

/**
 * Builds the agent message for a task, writing two separate files:
 *   - `.autodev/AGENT_PROFILE.md`                   — profile instructions (frontmatter stripped)
 *   - `.autodev/messages/MESSAGE_<timestamp>.md`     — task + current TODO
 *
 * Returns `{ prompt, messageFile }` where `prompt` is the combined string for UI
 * providers that cannot read files via @-references, and `messageFile` is the
 * absolute path of the written message file for CLI providers.
 */
/**
 * Assembles and writes `.autodev/AGENT_PROFILE.md` from the currently enabled
 * profile sections + any active MCP protocol injections. Also deploys / removes
 * Claude skill files for enabled / disabled MCPs.
 *
 * Called directly from the sidebar "Save & Rebuild Profile" button so the file
 * is updated immediately without waiting for a task run.
 */
export function rebuildProfile(root: string): void {
  // BULLETPROOF the program index: write a guaranteed minimal `.autodev/PROGRAM.md`
  // as the VERY FIRST action — before autodevDir / settings load / media assembly /
  // skills, any of which could throw on a Windows office scratch dir. The full
  // content overwrites it below when assembly succeeds; if any later step throws,
  // this minimal file survives so the agent still has its index. (A missing
  // PROGRAM.md made grok report "the program index is missing at the expected
  // path" and skip its protocol.) Best-effort — never throws.
  const bootstrapPath = path.join(root, AGENT_PROFILE_FILE);
  try {
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    if (!fs.existsSync(bootstrapPath) || fs.statSync(bootstrapPath).size === 0) {
      fs.writeFileSync(bootstrapPath, minimalProgramHeader(), 'utf8');
    }
  } catch { /* the full write below retries; if the FS is unwritable nothing helps */ }

  autodevDir(root);
  let settings: ReturnType<typeof loadSettingsForRoot> | undefined;
  try { settings = loadSettingsForRoot(root); } catch { /* ignore */ }

  // Assemble the profile body DEFENSIVELY: assembleProfileBody / applyProtocolSections
  // read bundled media and can throw on a Windows media-layout / path issue in an
  // office scratch dir. If they do, we must STILL write a non-empty PROGRAM.md
  // below (a swallowed throw here previously left PROGRAM.md uncreated → the
  // dispatcher's readFileSync(PROGRAM.md) threw ENOENT → the TASK failed). On any
  // failure fall back to the minimal header and empty section paths.
  let finalProfileBody = '';
  let sectionPaths: string[] = [];
  try {
    const enabledSections = settings?.enabledProfileSections ?? [];
    const customRefs = settings?.customProfileRefs ?? [];
    const assembled = assembleProfileBody(enabledSections, root, customRefs);
    sectionPaths = assembled.sectionPaths;
    finalProfileBody = applyProtocolSections(assembled.body, settings);
  } catch { finalProfileBody = ''; sectionPaths = []; }

  // ── CRITICAL WRITES FIRST ────────────────────────────────────────────────
  // Order matters: PROGRAM.md + SOUL.md are load-bearing (the dispatcher reads
  // PROGRAM.md at every turn; AGENTS.md/CLAUDE.md point at SOUL.md). They MUST be
  // written BEFORE the optional skill/MCP deployment, so that a skill/MCP failure
  // (a bundled-extension / Windows media-layout throw, a corrupt .claude tree)
  // can NEVER prevent them. Previously skills ran first and any throw there left
  // PROGRAM.md missing while SOUL.md still appeared via the loop's buildMessage
  // path — exactly the reported bug.
  //
  // Guarantee a NON-EMPTY PROGRAM.md even in the pathological case where
  // assembleProfileBody found no media (empty body) OR threw above: write at least
  // the SOUL/PROGRAM pointer header so the file is never blank/absent.
  const profileFilePath = path.join(root, AGENT_PROFILE_FILE);
  const bodyToWrite = finalProfileBody && finalProfileBody.trim().length > 0
    ? finalProfileBody
    : minimalProgramHeader();
  fs.writeFileSync(profileFilePath, bodyToWrite, 'utf8');
  // SOUL.md identity anchor — idempotent; never overwrites an existing SOUL.md.
  // Guaranteed to exist even for agents launched straight from the extension task
  // loop (which never run the office persona connect that used to create it).
  ensureSoulSkeleton(root);
  injectAgentProfileRef(root, sectionPaths);
  syncCopilotInstructions(root, bodyToWrite);

  // ── OPTIONAL DEPLOYMENT LAST (each isolated) ─────────────────────────────
  // Skill deployment lives on the PROFILE BUILD, not the per-message path: deploy
  // ALL bundled skills (incl. the master `.claude/skills/autodev/`) and the
  // per-MCP skill files here. Wrapped so a failure never rolls back the writes
  // above. (Both functions are also internally guarded; this is belt-and-braces.)
  try { applyAllSkills(root); } catch { /* skills are best-effort; PROGRAM.md/SOUL.md already written */ }
  try { applyMcpSkills(root, settings); } catch { /* per-MCP skills best-effort */ }

  // Cozempic reconcile: making cozempic opt-in only stopped NEW installs; a
  // workspace previously wired keeps its hooks until we remove them. When the box
  // is unchecked (cozempicAutoInit !== true) strip the already-installed cozempic
  // hooks so unchecking + Save & Rebuild actually cleans them. When enabled, the
  // task-loop install gate (_runCozempicInit) owns the install side — do nothing here.
  try {
    if (settings?.cozempicAutoInit !== true) { removeCozempicHooks(root); }
  } catch { /* best-effort */ }

  // INVARIANT (last action): PROGRAM.md must exist and be NON-EMPTY after a rebuild,
  // whatever happened above — a case-insensitive legacy cleanup on Windows, a throw
  // in skills/mcp/cozempic, or an FS hiccup. Re-assert it here so nothing can leave
  // the dispatcher's readFileSync(PROGRAM.md) staring at a missing/blank index (the
  // "PROGRAM.md missing on Windows" report). bodyToWrite already falls back to the
  // minimal header when the assembled body was empty. Best-effort; the dispatch path
  // has its own missing-PROGRAM fallback as a further backstop.
  try {
    const pf = path.join(root, AGENT_PROFILE_FILE);
    if (!fs.existsSync(pf) || fs.statSync(pf).size === 0) {
      fs.mkdirSync(path.dirname(pf), { recursive: true });
      fs.writeFileSync(pf, bodyToWrite, 'utf8');
    }
  } catch { /* best-effort — dispatch rebuilds PROGRAM.md if still missing */ }
}

/** Minimal non-empty PROGRAM.md fallback — used only if the assembled body is
 *  empty (no media found), so PROGRAM.md is NEVER written blank. */
function minimalProgramHeader(): string {
  return [
    '# AutoDev — PROGRAM.md',
    '',
    '> Master index. AGENTS.md / CLAUDE.md reference only this file.',
    '> (Profile media was unavailable at build time — this is the minimal',
    '> pointer header; rebuild once the profile media resolves for full content.)',
    '',
    '---',
    '',
    '## Agent Identity Anchor',
    '',
    'file://./SOUL.md',
    '<think>',
    'IMPORTANT: Read SOUL.md first — it is your persistent identity anchor',
    '(name, assigned persona, communication history). It persists across rebuilds.',
    '</think>',
    '',
  ].join('\n');
}

export function buildMessage(
  task: Task,
  root: string,
  todoDir: string,
  includeProfile = true,
  /**
   * True when this dispatch RESUMES an existing provider session (context — incl.
   * SOUL.md identity + PROGRAM.md protocol — is already loaded) and it is NOT the
   * first turn. Set by the loop from the same resume state the dispatcher uses
   * (grok variants always resume; everyone else honors `resumeSession`). Default
   * false so stateless providers / one-shot sends behave exactly as before.
   */
  resumedTurn = false,
): { prompt: string; messageFile: string } {
  autodevDir(root);

  // Read the noCommit flag from the identity section frontmatter (media source).
  const identityFile = path.join(__dirname, '..', 'media', 'profile', '00-identity.md');
  const { meta } = parseFrontmatter(readOrEmpty(identityFile));

  // PROGRAM.md + skill deployment live on the PROFILE BUILD (rebuildProfile — run
  // once at loop start and on explicit Save & Rebuild), NOT on this per-message
  // path. buildMessage no longer rewrites PROGRAM.md, re-deploys skills, or
  // re-injects the AGENTS/CLAUDE/Copilot refs every turn.
  //
  // SAFETY: writeCombinedFile reads PROGRAM.md at dispatch, so it must exist. If
  // it is missing (first turn before start ran, or a deleted file), build it once
  // here — idempotent: when it already exists we do NOT rewrite it.
  const profileFilePath = path.join(root, AGENT_PROFILE_FILE);
  if (!fs.existsSync(profileFilePath)) {
    try { rebuildProfile(root); } catch { /* dispatch will surface a clear error */ }
  }
  // Guarantee the SOUL.md identity anchor exists BEFORE we build the reminders
  // below (firstTurnSystemReminder / soulUpdatedReminder both point the agent
  // at it). Idempotent; never clobbers an existing identity/persona. (rebuildProfile
  // also ensures it, but keep this for the case PROGRAM.md exists yet SOUL.md does
  // not.) Creating it here (before soulUpdatedReminder) means the .soul-seen marker
  // records the skeleton's mtime silently on turn 1.
  ensureSoulSkeleton(root);
  // Build the task trigger message — profile is loaded by agents via AGENTS.md → @.autodev/PROGRAM.md
  const todoPath = path.join(todoDir, 'TODO.md');
  const taskMessage = buildTaskInstruction(task, todoPath, root, meta.noCommit);

  // System reminders that must precede the task text. The dispatcher feeds the
  // model from the messageFile (via writeCombinedFile), NOT from the returned
  // `prompt` string, so these MUST be written into the messageFile — otherwise
  // they are silently dropped for every provider.
  const reminders: string[] = [];
  // On the first turn of the session (same signal as includeProfile), prepend a
  // short system reminder pointing at PROGRAM.md (protocol index) + SOUL.md
  // (identity anchor). Gated on PROGRAM.md actually existing so a deleted file
  // never produces a broken pointer. Once per session/loop start — not every turn.
  if (includeProfile) {
    const reminder = firstTurnSystemReminder(root);
    if (reminder) { reminders.push(reminder); }
  }
  // On ANY turn, if SOUL.md changed since we last saw it (e.g. the office edited the
  // agent's identity live), tell the agent to re-read it — not just on turn 1.
  const soulUpd = soulUpdatedReminder(root);
  const soulChanged = !!soulUpd;
  if (soulUpd) { reminders.push(soulUpd); }

  // On a RESUMED turn (resuming provider, past turn 1), identity+protocol are
  // already in the live context — inject a per-turn override that suppresses the
  // standing "re-read SOUL/PROGRAM every message" pillars so the agent doesn't
  // open every turn re-reading what it already holds. Gated so it never fights the
  // other reminders: skipped on the first turn (`includeProfile` — that turn must
  // load identity) and skipped when SOUL.md actually changed this turn (the
  // soulUpdatedReminder re-read wins). Additive: default resumedTurn=false leaves
  // stateless providers and one-shot sends untouched.
  if (resumedTurn && !includeProfile && !soulChanged) {
    const resumed = resumedSessionReminder(root);
    if (resumed) { reminders.push(resumed); }
  }

  // Reminders FIRST, then the task text, written to the file the model reads.
  const messageBody = [...reminders, taskMessage].join('\n\n---\n\n');
  const messageFile = writeMessageFile(root, messageBody);

  // The combined `prompt` string mirrors the messageFile ordering for the
  // (currently unused) UI-provider path. The profile body is NOT inlined here —
  // it lives in PROGRAM.md on disk and is appended by writeCombinedFile at
  // dispatch (profile build owns PROGRAM.md; this path owns only the reminders +
  // task text).
  const parts: string[] = [...reminders, taskMessage];
  return { prompt: parts.join('\n\n---\n\n'), messageFile };
}
