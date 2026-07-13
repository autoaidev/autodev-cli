import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Task } from './todo';
import { autodevDir } from './sessionState';
import { applyProtocolSections, applyMcpSkills, applyAllSkills } from './protocolSections';
import { assembleProfileBody } from './profileBuilder';
import { loadSettingsForRoot } from './core/settingsLoader';

// ---------------------------------------------------------------------------
// File path constants — all files live under <workspace>/.autodev/
// ---------------------------------------------------------------------------

/** Agent profile instructions written for each task run */
export const AGENT_PROFILE_FILE = '.autodev/AGENT_PROFILE.md';

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
function injectAgentProfileRef(root: string, sectionPaths: string[] = []): void {
  // Inject AGENT_PROFILE.md plus every deployed section file using relative
  // file:// paths so references survive workspace folder moves/renames.
  const allPaths = [AGENT_PROFILE_FILE, ...sectionPaths];
  const markerRe = /<!-- autodev:profile-ref:begin -->[\s\S]*?<!-- autodev:profile-ref:end -->/;

  for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(root, filename);

    let block: string;

    if (filename === 'CLAUDE.md' && fs.existsSync(path.join(root, 'AGENTS.md'))) {
      // CLAUDE.md: thin redirect → points to AGENTS.md which is the primary file.
      // Claude reads AGENTS.md first; all real profile refs live there.
      block = [
        AGENT_REF_BEGIN,
        // Relative file:// path — works regardless of absolute workspace location
        `file://./AGENTS.md`,
        `<think>`,
        `IMPORTANT: AGENTS.md is the primary instruction file. Read and follow all instructions in AGENTS.md before proceeding.`,
        `</think>`,
        AGENT_REF_END,
      ].join('\n');
    } else {
      // AGENTS.md (primary) — or CLAUDE.md when no AGENTS.md exists: full reference block.
      // Use relative file:// paths so references survive workspace moves.
      const fileLines = allPaths
        .map(p => `file://./${p.replace(/\\/g, '/')}`)
        .join('\n');
      const thinkBlock = `<think>\nIMPORTANT: Read all the instruction files listed above before proceeding.\nThey contain your core protocols, rules, and operational guidelines.\n</think>`;
      block = `${AGENT_REF_BEGIN}\n${fileLines}\n${thinkBlock}\n${AGENT_REF_END}`;
    }

    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }
    if (markerRe.test(content)) {
      // Replace existing block
      content = content.replace(markerRe, block);
    } else {
      // Prepend block — agents read the top of the file first
      content = block + (content ? '\n\n' + content : '');
    }
    fs.writeFileSync(filePath, content, 'utf8');
  }
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
  autodevDir(root);
  let settings: ReturnType<typeof loadSettingsForRoot> | undefined;
  try { settings = loadSettingsForRoot(root); } catch { /* ignore */ }

  const enabledSections = settings?.enabledProfileSections ?? [];
  const customRefs = settings?.customProfileRefs ?? [];
  const { body: profileBody, sectionPaths } = assembleProfileBody(enabledSections, root, customRefs);
  const finalProfileBody = applyProtocolSections(profileBody, settings);
  applyMcpSkills(root, settings);

  const profileFilePath = path.join(root, AGENT_PROFILE_FILE);
  fs.writeFileSync(profileFilePath, finalProfileBody, 'utf8');
  injectAgentProfileRef(root, sectionPaths);
  syncCopilotInstructions(root, finalProfileBody);
}

export function buildMessage(
  task: Task,
  root: string,
  todoDir: string,
  includeProfile = true,
): { prompt: string; messageFile: string } {
  autodevDir(root);

  // Load workspace settings (MCP servers, enabled profile sections, etc.)
  let settings: ReturnType<typeof loadSettingsForRoot> | undefined;
  try { settings = loadSettingsForRoot(root); } catch { /* ignore */ }

  // Read the noCommit flag from the identity section frontmatter
  const identityFile = path.join(__dirname, '..', 'media', 'profile', '00-identity.md');
  const { meta } = parseFrontmatter(readOrEmpty(identityFile));

  // Assemble the profile index from the enabled section files
  const enabledSections = settings?.enabledProfileSections ?? [];
  const customRefs = settings?.customProfileRefs ?? [];
  const { body: profileBody, sectionPaths } = assembleProfileBody(enabledSections, root, customRefs);

  // Inject protocol sections (email, jira, ...) for any MCP currently enabled
  // in the workspace settings. Toggling an MCP off cleanly removes its block
  // on the next regeneration.
  const finalProfileBody = applyProtocolSections(profileBody, settings);

  // Copy all general skills from media/skills/ to .claude/skills/
  if (root) { applyAllSkills(root); }
  
  // Deploy / remove Claude skill files for enabled / disabled MCPs
  if (root) { applyMcpSkills(root, settings); }

  // Always write the profile file so the LLM can @-reference it
  const profileFilePath = path.join(root, AGENT_PROFILE_FILE);
  fs.writeFileSync(profileFilePath, finalProfileBody, 'utf8');
  injectAgentProfileRef(root, sectionPaths);
  syncCopilotInstructions(root, finalProfileBody);
  // Build the task trigger message — profile is loaded by agents via AGENTS.md → @.autodev/AGENT_PROFILE.md
  const todoPath = path.join(todoDir, 'TODO.md');
  const taskMessage = buildTaskInstruction(task, todoPath, root, meta.noCommit);

  const messageFile = writeMessageFile(root, taskMessage);

  // Task message FIRST so the agent sees what to do immediately,
  // then the full protocol/profile follows as context.
  const parts: string[] = [];
  parts.push(taskMessage);
  if (includeProfile && finalProfileBody.trim()) {
    parts.push(`# Project Instructions (AUTODEV.md)\n\n${finalProfileBody.trim()}`);
  }
  return { prompt: parts.join('\n\n---\n\n'), messageFile };
}
