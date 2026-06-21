import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Generate a task ID like "task-2026-04-21-a3f9k2" */
export function shortId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const hash = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `task-${date}-${hash}`;
}

// ---------------------------------------------------------------------------
// TODO.md parser — mirrors PHP TodoParser/TodoWriter
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'in-progress' | 'done';

export interface Task {
  id?: string;
  status: TaskStatus;
  text: string;
  completedDate?: string;
  /** 1-based line number in the file */
  line: number;
  /**
   * Workspace-relative paths to attachment files embedded in the task text.
   * Populated at parse time from markdown links that point inside
   * `.autodev/messages/attachments/`. Ready to use — no regex scanning needed.
   */
  attachments?: string[];
}

/** Parse TODO.md into an ordered list of Tasks. */
export function parseTodo(filePath: string): Task[] {
  if (!fs.existsSync(filePath)) { return []; }
  const content = fs.readFileSync(filePath, 'utf8');
  return parseTodoContent(content);
}

export function parseTodoContent(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const task = parseLine(lines[i], i + 1);
    if (task) { tasks.push(task); }
  }
  return tasks;
}

/** Extract optional leading task ID, e.g. "[task-2026-04-21-a3f9k2] actual text" */
function extractId(raw: string): { id?: string; text: string } {
  const m = raw.match(/^\[(task-(?:\d{4}-\d{2}-\d{2}|\d{8})-[a-f0-9]{6})\]\s+(.+)$/i);
  if (m) { return { id: m[1], text: m[2] }; }
  return { text: raw };
}

/**
 * Extract workspace-relative attachment paths from task text.
 * Matches markdown links whose href points inside .autodev/messages/attachments/
 * as well as bare paths of the same form.
 */
function extractAttachments(text: string): string[] {
  const paths: string[] = [];
  // Markdown links: [label](/.autodev/messages/attachments/group/file)
  // Use (?:[^\[\]]|\[[^\]]*\])* for the label to handle JIRA-style subjects
  // like [[URGENT] Subject Text](url) that contain ] inside the label.
  const linkRe = /\[(?:[^\[\]]|\[[^\]]*\])*\]\(\/?((?:[^)]*\/)?[.]autodev\/messages\/attachments\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    const rel = m[1].replace(/\\/g, '/');
    if (!paths.includes(rel)) { paths.push(rel); }
  }
  // Bare paths: .autodev/messages/attachments/group/file
  const bareRe = /(?:^|[\s(['"])(\.autodev\/messages\/attachments\/[^\s)'"]+)/g;
  while ((m = bareRe.exec(text)) !== null) {
    const rel = m[1].replace(/\\/g, '/');
    if (!paths.includes(rel)) { paths.push(rel); }
  }
  return paths;
}

function parseLine(line: string, lineNo: number): Task | null {
  const ln = line.trimEnd();

  // Done:        - [x] 2026-02-28  text
  let m = ln.match(/^\s*(?:-\s*)?\[x\]\s*(\d{4}-\d{2}-\d{2}\s+)?(.+)$/iu);
  if (m) {
    const { id, text } = extractId(m[2].trim());
    const attachments = extractAttachments(text);
    return { id, status: 'done', text, completedDate: m[1]?.trim(), line: lineNo, ...(attachments.length ? { attachments } : {}) };
  }

  // In progress: - [~] text
  m = ln.match(/^\s*(?:-\s*)?\[~\]\s*(.+)$/iu);
  if (m) {
    const { id, text } = extractId(m[1].trim());
    const attachments = extractAttachments(text);
    return { id, status: 'in-progress', text, line: lineNo, ...(attachments.length ? { attachments } : {}) };
  }

  // Todo:        - [ ] text
  m = ln.match(/^\s*(?:-\s*)?\[\s+\]\s*(.+)$/iu);
  if (m) {
    const { id, text } = extractId(m[1].trim());
    const attachments = extractAttachments(text);
    return { id, status: 'todo', text, line: lineNo, ...(attachments.length ? { attachments } : {}) };
  }

  return null;
}

/** Return the first todo task (not in-progress), or null if none pending. */
export function pickNextTask(tasks: Task[]): Task | null {
  return tasks.find(t => t.status === 'todo') ?? null;
}

export function countRemaining(tasks: Task[]): number {
  return tasks.filter(t => t.status === 'todo' || t.status === 'in-progress').length;
}

// ---------------------------------------------------------------------------
// TODO.md writer — mark tasks in-progress or done
// ---------------------------------------------------------------------------

export function markInProgress(filePath: string, task: Task): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const escaped = escapeRegex(task.text);
  const updated = content.replace(
    new RegExp(`(^\\s*(?:-\\s*)?)(\\[\\s+\\])(\\s+${escaped}.*)$`, 'mu'),
    '$1[~]$3'
  );
  fs.writeFileSync(filePath, updated, 'utf8');
}

/** Reset a [~] in-progress task back to [ ] todo. */
export function resetToTodo(filePath: string, task: Task): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const escaped = escapeRegex(task.text);
  const updated = content.replace(
    new RegExp(`(^\\s*(?:-\\s*)?)\\[~\\](\\s+${escaped}.*)$`, 'mu'),
    '$1[ ]$2'
  );
  fs.writeFileSync(filePath, updated, 'utf8');
}

/** Reset ALL [~] in-progress tasks back to [ ] todo. */
export function resetAllInProgress(filePath: string): void {
  if (!fs.existsSync(filePath)) { return; }
  const content = fs.readFileSync(filePath, 'utf8');
  const updated = content.replace(/^(\s*(?:-\s*)?)\[~\]/gmu, '$1[ ]');
  fs.writeFileSync(filePath, updated, 'utf8');
}

export function markDone(filePath: string, task: Task): void {
  const date = new Date().toISOString().slice(0, 10);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Primary: replace by line number — preserves the full original text including
  // any [task-id] prefix, which the regex approach would miss (task.text strips the ID).
  const lineIdx = task.line - 1;
  if (lineIdx >= 0 && lineIdx < lines.length) {
    const ln = lines[lineIdx];
    const m = ln.match(/^(\s*(?:-\s*)?)(?:\[~\]|\[\s+\])(\s+.+)$/iu);
    if (m) {
      // Preserve everything after the marker (including any [task-id] prefix)
      lines[lineIdx] = `${m[1]}[x] ${date}  ${m[2].trimStart()}`;
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
      return;
    }
  }

  // Fallback: scan all lines — line number may have shifted since task was parsed.
  // Match by task ID if available, otherwise by text (accounting for optional [task-id] prefix).
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/^(\s*(?:-\s*)?)(?:\[~\]|\[\s+\])\s+(.+)$/iu);
    if (!m) { continue; }
    const rawText = m[2].trim();
    const idMatch = rawText.match(/^\[(task-(?:\d{4}-\d{2}-\d{2}|\d{8})-[a-f0-9]{6})\]\s+(.+)$/i);
    const lineId   = idMatch ? idMatch[1] : undefined;
    const lineText = idMatch ? idMatch[2] : rawText;
    const matches = (task.id && lineId === task.id) || lineText === task.text;
    if (matches) {
      lines[i] = `${m[1]}[x] ${date}  ${rawText}`;
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
      return;
    }
  }

  // Nothing matched — write unchanged (better than corrupting the file)
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Append a new task line to the ## Todo section (at the bottom, before the next heading). */
export function appendTask(filePath: string, text: string, id?: string): string {
  const taskId = id ?? shortId();
  const line = `- [ ] [${taskId}] ${text}`;
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const todoMatch = content.match(/^(##\s+Todo\s*\n)/mu);
  if (todoMatch && todoMatch.index !== undefined) {
    const afterHeading = todoMatch.index + todoMatch[0].length;
    // Find the next ## heading after the Todo heading (In Progress / Done / etc.)
    const rest = content.slice(afterHeading);
    const nextSection = rest.match(/^##\s+/mu);
    const insertAt = nextSection ? afterHeading + nextSection.index! : content.length;
    // Ensure the preceding content ends with a newline so the new task is on its own line
    const before = content.slice(0, insertAt);
    const after  = content.slice(insertAt);
    const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    content = before + sep + line + '\n' + after;
  } else {
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content += sep + `## Todo\n${line}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return taskId;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// TODO pruning — move completed tasks to DONE.md
// ---------------------------------------------------------------------------

/**
 * Move all completed `[x]` lines from `todoPath` into
 * `<workspaceRoot>/DONE.md`, grouped under a dated heading.
 *
 * - The original `[x]` lines (and any immediately-following indented subtask
 *   lines that belong to them) are removed from `TODO.md`.
 * - `DONE.md` is created if it does not exist; entries are appended
 *   so history is never lost.
 * - Returns the number of top-level `[x]` lines moved.
 */
export function pruneTodoToArchive(todoPath: string, workspaceRoot: string): number {
  if (!fs.existsSync(todoPath)) { return 0; }

  const raw = fs.readFileSync(todoPath, 'utf8');
  const lines = raw.split('\n');

  const keptLines: string[] = [];
  const doneLines: string[] = [];
  let doneCount = 0;

  // Walk line-by-line.  A done block = the [x] line itself plus any
  // immediately-following lines that are indented (subtasks / continuations).
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isDone = /^\s*(?:-\s*)?\[x\]/iu.test(line);

    if (isDone) {
      doneCount++;
      doneLines.push(line);
      i++;
      // Collect indented continuation lines that belong to this done task
      while (i < lines.length) {
        const next = lines[i];
        // A continuation is any non-empty line that starts with whitespace
        // (indented subtask) and is not itself a new top-level task marker
        if (next.trim() === '') { break; }
        if (/^\s+/.test(next) && !/^\s*(?:-\s*)?\[/.test(next)) {
          doneLines.push(next);
          i++;
        } else {
          break;
        }
      }
    } else {
      keptLines.push(line);
      i++;
    }
  }

  if (doneCount === 0) { return 0; }

  // Re-write TODO.md without the done lines, collapsing consecutive blank lines
  const newTodo = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // collapse 3+ blank lines to 2
    .trimEnd() + '\n';
  fs.writeFileSync(todoPath, newTodo, 'utf8');

  // Append to DONE.md
  const archivePath = path.join(workspaceRoot, 'DONE.md');
  const date = new Date().toISOString().slice(0, 10);
  const heading = `\n## Archived ${date}\n\n`;
  const archiveBlock = heading + doneLines.join('\n') + '\n';

  if (!fs.existsSync(archivePath)) {
    fs.writeFileSync(archivePath, '# TODO Archive\n\nCompleted tasks archived from TODO.md.\n' + archiveBlock, 'utf8');
  } else {
    fs.appendFileSync(archivePath, archiveBlock, 'utf8');
  }

  return doneCount;
}
