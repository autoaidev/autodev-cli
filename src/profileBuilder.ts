import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Profile section definitions
// ---------------------------------------------------------------------------

export interface ProfileSection {
  /** Slug used in HTML comment markers and settings key */
  id: string;
  /** Human-readable label for the sidebar ProfileBuilder checkbox */
  label: string;
  /** Filename inside media/profile/ */
  file: string;
  /** 2–3 critical rules shown inline in the index. Full content lives in the file. */
  keyRules: string[];
}

export const PROFILE_SECTIONS: ProfileSection[] = [
  {
    id: '00-identity', label: 'Identity & Autonomous Mode', file: '00-identity.md',
    keyRules: [
      'Fully autonomous — never ask questions or wait for confirmation. Decide and act.',
      'FIRST ACTION on every task: mark `[ ]` → `[~]` in TODO.md BEFORE anything else.',
      'Never end the session while `[ ]` or `[~]` tasks remain.',
    ],
  },
  {
    id: '01-learning', label: 'Session Start Order (SUMMARY.md)', file: '01-learning.md',
    keyRules: [
      'Read in order: SOUL.md → AGENTS.md → SUMMARY.md → LESSONS.md → CONTRACTS.md → open issues → KB → TODO.md.',
      'Update SUMMARY.md whenever you discover non-obvious facts or make architectural decisions.',
    ],
  },
  {
    id: '02-memory-mcp', label: 'Memory MCP — State Persistence', file: '02-memory-mcp.md',
    keyRules: [
      'Query Memory MCP before reading TODO.md — load all project nodes first.',
      'After every `[x]`: write ≥1 Memory MCP node (what changed, gotcha, convention).',
    ],
  },
  {
    id: '03-living-docs', label: 'Living Project Docs', file: '03-living-docs.md',
    keyRules: [
      'Keep PROJECT.md, LESSONS.md, TROUBLESHOOTING.md, SETUP.md, CHANGELOG.md current every session.',
      'Every resolved error → TROUBLESHOOTING.md. Every `[x]` → CHANGELOG.md. Every correction → LESSONS.md.',
    ],
  },
  {
    id: '04-skill-files', label: 'Automatic Skill Development (AGENTS.md)', file: '04-skill-files.md',
    keyRules: [
      'AGENTS.md is single source of truth — read it before starting any task.',
      'Update AGENTS.md (+ sync Copilot file) whenever a convention, pattern, or footgun is confirmed.',
    ],
  },
  {
    id: '05-skill-creation', label: 'Skill Creation Protocol', file: '05-skill-creation.md',
    keyRules: [
      'Create .claude/skills/<slug>/SKILL.md when solution required 3+ failed attempts or agent would repeat mistake.',
      'Add slug + summary to AGENTS.md `## Project Skills` after creating a skill.',
    ],
  },
  {
    id: '06-core-rules', label: 'Core Rules & File Placement', file: '06-core-rules.md',
    keyRules: [
      'Read every file before touching it. Never assume structure, conventions, or config.',
      'YOU run tests/lints/builds directly. Subagents only for: implementation (Code), test writing (QA), review (Reviewer).',
      'Think deeply; context unwieldy → summarise → spawn subagent with clean scope. Never silently degrade.',
    ],
  },
  {
    id: '07-core-loop', label: 'Core Loop & Task Classification', file: '07-core-loop.md',
    keyRules: [
      'Loop: MARK [~] → PLAN → DISPATCH → VERIFY → MARK [x] → commit → next task.',
      'Re-read TODO.md after every [x]; never end while [ ] or [~] remain. Full loop: skill `autodev-core-loop`.',
    ],
  },
  {
    id: '08-thinking', label: 'Thinking, Decomposition & Validation', file: '08-thinking.md',
    keyRules: [
      'Answer 6 questions before dispatching: Scope, Impact, Patterns, Risks, Approach, Done criteria.',
      'Validation panel (Simplicity · Assumption · User · Priority) must run before every [x].',
    ],
  },
  {
    id: '09-parallel-panel', label: 'Parallel Specialist Panel (§2)', file: '09-parallel-panel.md',
    keyRules: [
      'Five specialists: Architect (design) → Coder (edit files) → Reviewer (review) → Tester (write tests) → Ops.',
      'Orchestrator runs tests/lints/builds directly after Coder finishes — NOT through subagent.',
      'BLOCKER from Reviewer or Tester failure → back to Coder → re-run both gates.',
    ],
  },
  {
    id: '10-codebase-verification', label: 'Codebase Orientation & Verification', file: '10-codebase-verification.md',
    keyRules: [
      'Orient before dispatching: entry point, browser UI?, test runner, core modules, config.',
      'Verify: local tests + lint/build + browser (if UI) + browser test suite + security scan before every commit.',
    ],
  },
  {
    id: '11-git-debug-security', label: 'Git, Debugging & Security', file: '11-git-debug-security.md',
    keyRules: [
      'Conventional commits. One logical change per commit. Commit only after Verifier passes.',
      'Debug: read full error → locate → context → trace → hypothesis → re-dispatch → re-verify.',
    ],
  },
  {
    id: '12-todo-format', label: 'TODO.md Format & Marking Rules', file: '12-todo-format.md',
    keyRules: [
      '`[ ]` pending · `[~]` in-progress · `[x] YYYY-MM-DD` done (two spaces after date, lowercase x).',
      'Non-trivial task → add checkable subtask list; final subtask is always verification.',
    ],
  },
  {
    id: '13-workflow-principles', label: 'Workflow, Quality & Principles', file: '13-workflow-principles.md',
    keyRules: [
      'Quality: no magic values, explicit types, single responsibility, fail loudly, surgical changes, simplicity first.',
      'Principles: Plan before code · Read first always · Subagents are leverage · Own the outcome.',
    ],
  },
  {
    id: '14-contracts', label: 'Agent Contracts (CONTRACTS.md)', file: '14-contracts.md',
    keyRules: [
      'Email is the primary agent-to-agent medium. Jira comments do NOT notify agents — email is mandatory.',
      'Never invent or guess an address. Read CONTRACTS.md before any contact. Full skeleton: skill `contracts`.',
      'An ACK / NO_NEXT / "CLOSED" / "COMPLETE"/"DONE"/"ACCEPTED" / re-verify message is TERMINAL — do NOT reply to it, do NOT re-verify or re-close an already-closed thread, do NOT send an ACK of an ACK. Silence IS the acknowledgement.',
      'Only send a message that carries NEW substantive work, a decision a peer is blocked on, or a genuine first-time close. If you have nothing new, send NOTHING and go idle. When the project/deliverable is complete, stand down and stop initiating messages — do not keep the thread alive with courtesy replies.',
    ],
  },
  {
    id: '15-soul', label: 'Soul Protocol — Agent Identity', file: '15-soul.md',
    keyRules: [
      'Read SOUL.md first — before SUMMARY.md, before everything. It holds your name, addresses, history.',
      'Append Communication History after every message. Never invent addresses.',
    ],
  },
  {
    id: '16-journal', label: 'Research Journal & Auto-Learn Loop', file: '16-journal.md',
    keyRules: [
      'Research loop: HYPOTHESIS → IMPLEMENT → VERIFY → LOG → KEEP/DISCARD → REPEAT.',
      'Write a row before/after any task that modifies 2+ files or involves a non-obvious fix.',
    ],
  },
  {
    id: '17-issue-tracking', label: 'Issue Tracking (.autodev/issues/)', file: '17-issue-tracking.md',
    keyRules: [
      'Create .autodev/issues/ISSUE-NNN-kebab-title.md before doing any work on an issue.',
      'Append Work Log + attach artifacts on every session touching the issue. Resolved needs 1+ artifact.',
    ],
  },
  {
    id: '18-knowledgebase', label: 'Knowledge Base (.autodev/knowledgebase/)', file: '18-knowledgebase.md',
    keyRules: [
      'Create KB-NNN-kebab-title.md the moment an architectural decision, pattern, or gotcha is confirmed.',
      'Never delete KB entries — deprecate with Status: Deprecated + Superseded by link.',
    ],
  },
  {
    id: '19-subagent-context-management', label: 'Subagent Context Management', file: '19-subagent-context-management.md',
    keyRules: [
      'Create CONTEXT.md for complex multi-step tasks to prevent losing track of main goal during deep work.',
      'Subagents NEVER for: running tests/lints/builds, reading files, deciding what to do, or "compacting YOUR context".',
      'Before spawning subagent: decide approach, write detailed brief (mission, context, files, patterns, done criteria).',
    ],
  },
];

/** Returns all section IDs in order — useful as the default "all enabled" value. */
export const ALL_SECTION_IDS: string[] = PROFILE_SECTIONS.map(s => s.id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profileMediaDir(): string {
  return path.join(__dirname, '..', 'media', 'profile');
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Copy a section file from `media/profile/` to `<root>/.autodev/profile/`
 * so it is accessible via `@.autodev/profile/<file>` references inside the
 * workspace. Returns the workspace-relative `@` path, or null on failure.
 */
function deploySectionFile(section: ProfileSection, root: string): string | null {
  const src = path.join(profileMediaDir(), section.file);
  if (!fs.existsSync(src)) { return null; }
  const destDir = path.join(root, '.autodev', 'profile');
  if (!fs.existsSync(destDir)) { fs.mkdirSync(destDir, { recursive: true }); }
  const dest = path.join(destDir, section.file);
  try {
    fs.copyFileSync(src, dest);
    return `.autodev/profile/${section.file}`;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Profile assembly — index format
// ---------------------------------------------------------------------------

/**
 * Assemble AGENT_PROFILE.md as a compact **index**:
 * - Each enabled section shows its key rules inline (immediate context).
 * - A `@.autodev/profile/<file>` line lets agents load the full section on demand.
 * - Full section files are copied to `<root>/.autodev/profile/` so the `@`
 *   references resolve inside the workspace.
 * - Custom `@path` references are appended at the end.
 *
 * @param enabledIds    Section IDs to include. Empty = all sections.
 * @param root          Workspace root. Required to deploy section files.
 * @param customRefs    Additional `@path` lines to append (from user settings).
 */
export function assembleProfileBody(
  enabledIds: string[] | undefined,
  root: string,
  customRefs: string[] = [],
): { body: string; sectionPaths: string[] } {
  const ids = enabledIds && enabledIds.length > 0 ? enabledIds : ALL_SECTION_IDS;
  const orderedSections = PROFILE_SECTIONS.filter(s => ids.includes(s.id));

  const header = [
    '# AutoDev Agent Profile',
    '',
    '> This is a **protocol index**. Each section file is loaded directly by the agent.',
    '> Key rules are summarised below; full details live in the per-section files.',
    '',
    '---',
    '',
  ].join('\n');

  const parts: string[] = [];
  const sectionPaths: string[] = [];

  for (const section of orderedSections) {
    const refPath = deploySectionFile(section, root);
    if (refPath) { sectionPaths.push(refPath); }
    const rulesLines = section.keyRules.map(r => `- ${r}`).join('\n');
    // Hash over key rules + ref so the marker changes if either is updated
    const hash = md5(rulesLines + (refPath ?? ''));
    const block = [
      `<!-- AUTODEV:section:${section.id}:begin:md5=${hash} -->`,
      `### ${section.label}`,
      rulesLines,
      `<!-- AUTODEV:section:${section.id}:end -->`,
    ].join('\n');
    parts.push(block);
  }

  let body = header + parts.join('\n\n') + '\n';

  // Append custom references
  const validCustom = customRefs.map(r => r.trim()).filter(r => r.length > 0);
  if (validCustom.length > 0) {
    body += '\n---\n\n## Custom References\n\n';
    body += validCustom.map(r => {
      // Remove @ prefix if present
      const cleanPath = r.startsWith('@') ? r.substring(1) : r;
      // Use a relative file:// path so the reference survives workspace moves.
      const relPath = path.isAbsolute(cleanPath)
        ? path.relative(root, cleanPath).replace(/\\/g, '/')
        : cleanPath.replace(/\\/g, '/');
      return `file://./${relPath}`;
    }).join('\n');
    body += '\n';
  }

  // Always append SOUL.md reference so agents load their identity anchor first.
  body += [
    '',
    '---',
    '',
    '## Agent Identity Anchor',
    '',
    `file://./SOUL.md`,
    '<think>',
    'IMPORTANT: Read SOUL.md before processing any incoming message.',
    'It contains your name, your contact addresses, and your full communication history.',
    'When a message arrives, check ## Communication History to recognise the thread.',
    'Never act confused about who you are — your identity is stable across all sessions.',
    'If SOUL.md does not exist yet, create it from the skeleton in §0.0.',
    '</think>',
    '',
  ].join('\n');

  // Always append JOURNAL.md reference so agents write and read the research log.
  body += [
    '',
    '---',
    '',
    '## Research Journal',
    '',
    `file://./JOURNAL.md`,
    '<think>',
    'IMPORTANT: Before every non-trivial task, write a hypothesis row in JOURNAL.md (status: pending).',
    'After the task: update the row to keep or discard. Apply the simplicity criterion.',
    'Commit JOURNAL.md together with the code change. Never delete rows — discards are valuable data.',
    'If JOURNAL.md does not exist yet, create it from the skeleton in §0.6.',
    '</think>',
    '',
  ].join('\n');

  // Always append a direct reference to CONTRACTS.md so agents auto-load
  // the project's contact directory regardless of which sections are enabled.
  body += [
    '',
    '---',
    '',
    '## Project Contact Directory',
    '',
    `file://./CONTRACTS.md`,
    '<think>',
    'IMPORTANT: Read CONTRACTS.md before sending any email, message, or task to another agent.',
    'It lists every human and agent contact address, per-channel routing rules, and the escalation',
    'thresholds that must be met before contacting the human.',
    'Never invent or guess a contact address — if it is not in CONTRACTS.md, do not send.',
    '</think>',
    '',
  ].join('\n');

  // Always append issue tracking and knowledge base anchors.
  body += [
    '',
    '---',
    '',
    '## Open Issues',
    '',
    `file://./.autodev/issues/`,
    '<think>',
    'IMPORTANT: At session start, scan .autodev/issues/ for ISSUE-*.md files whose Status is not Resolved or Closed.',
    'Re-read each open issue file before starting work so context is fully loaded.',
    'When assigned a ticket or bug, create .autodev/issues/ISSUE-NNN-kebab-title.md immediately — before any code or email.',
    'If .autodev/issues/ does not exist yet, create it and the first issue file from the skeleton in §0.7.',
    '</think>',
    '',
  ].join('\n');

  body += [
    '',
    '---',
    '',
    '## Knowledge Base',
    '',
    `file://./.autodev/knowledgebase/`,
    '<think>',
    'IMPORTANT: Before starting any non-trivial task, scan .autodev/knowledgebase/ for KB entries relevant to that task.',
    'When a session produces a reusable insight (architectural decision, pattern, gotcha, confirmed API behaviour),',
    'create .autodev/knowledgebase/KB-NNN-kebab-title.md immediately — do not wait until the end of the session.',
    'Cross-reference KB entries and issue files bidirectionally. Never delete KB entries — deprecate with a forward link.',
    'If .autodev/knowledgebase/ does not exist yet, create it and the first KB entry from the skeleton in §0.8.',
    '</think>',
    '',
  ].join('\n');

  return { body, sectionPaths };
}
