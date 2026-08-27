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
    id: '00a-proactive-discovery', label: 'Proactive Discovery', file: '00a-proactive-discovery.md',
    keyRules: [
      'On startup/join: run the discovery sweep — SOUL (who am I) → list_agents (roster+presence) → living docs+codebase (what is this) → tools/skills/MCP inventory → get_tasks/TODO+check_messages (the work) → graph_map/graph_search + Memory (what is already known).',
      'When idle or between tasks: PROACTIVELY find work — re-read TODO/get_tasks, explore the codebase, query the graph/memory, coordinate over A2A (send_message/check_messages), surface blockers. Never sit and wait to be spoon-fed context.',
      'Discover, then judge — recall before acting, read before touching, use the real tool/graph fact instead of guessing; do not act blindly and do not spam teammates.',
    ],
  },
  {
    id: '00b-self-verifiable-work', label: 'Self-Verifiable Work', file: '00b-self-verifiable-work.md',
    keyRules: [
      'Never mark [x] / complete_task / say "done" on a vibe — state the objective, rule-based check you ran and its result (tests green, build 0 errors, script exits 0, endpoint 200, file has expected content, diff applied). "Looks right" is not evidence.',
      'No checker? BUILD one before closing — write a failing test, define measurable acceptance criteria in TODO.md, capture before/after, assert an expected exit-code/HTTP-200/file-exists, or re-run from a clean state.',
      'High stakes or fuzzy check → get a RELATIVE second verification (adversarial self-review, or a teammate over A2A via send_message/check_messages, or an independent re-run) rather than trusting one self-judgment. Verify with real gates: the project tests/build/lint, the verify_and_keep gate (.autodev/CONTROL.md), read_file back your writes.',
    ],
  },
  {
    id: '00c-verifiable-threads', label: 'Self-Verifying Message Threads & Todos', file: '00c-verifiable-threads.md',
    keyRules: [
      'Assume every recipient is context-degraded (different session, never saw your reasoning) — write each A2A message (send_message) and each task/TODO.md hand-off so an agent who saw NONE of your run could act AND verify: state the goal, the exact artifact (path/command/ticket id/office slug), and the objective acceptance criterion. No "the file"/"that bug"/"as discussed" — those are context-gap tells.',
      'Read as a detector: on check_messages/get_tasks look for the tells of a degraded sender (vague referents, missing acceptance criterion, stale refs). If you spot a gap, recover it (check_messages/get_events/agent_profile) or send ONE clarifying send_message BEFORE acting — never act on a degraded instruction and propagate the error downstream.',
      'Close the loop verifiably: complete_task/status reports the objective result (what changed, where, how checked, pass/fail with command+output) — never a bare "done". A report a fresh reader can verify keeps the thread honest; a vague "done" is the context-gap tell.',
    ],
  },
  {
    id: '00d-turn-end-retrospective', label: 'Turn-End Honest Retrospective & Next Steps', file: '00d-turn-end-retrospective.md',
    keyRules: [
      'End every turn with a CANDID opinion, not spin: what you achieved vs intended and how much is VERIFIED (a check ran) vs merely assumed; what went wrong/shaky/skipped/uncertain, stated plainly; what you\'d do differently plus any HONEST DISAGREEMENT with the approach or task; calibrated confidence. A cheerful "all done ✅" that hides a partial failure or rubber-stamps a bad plan is a failure of this protocol, not politeness.',
      'Follow the verdict with concrete NEXT STEPS: the specific next actions ordered by priority with real handles (file path, task id, command, office slug), blockers + what/who unblocks them, and what you RECOMMEND even if nobody asked ("if I were you I\'d do X next").',
      'Always state it in your closing output; if you are an office/loop agent make it durable — set_status with a terse honest state, a brief send_message to the owner/next agent when there is something to act on, and write next-steps into TODO.md (manage_agent_todos) so the thread survives your context reset. Keep it proportional — a tight paragraph or a few bullets, never a wall of text.',
    ],
  },
  {
    id: '00e-long-horizon-planning', label: 'Long-Horizon Task Planner', file: '00e-long-horizon-planning.md',
    keyRules: [
      'Plan the full arc BEFORE executing: decompose the task end-to-end into an ordered set of COMPLETE milestones, each with its own acceptance criterion, up to one explicit "done for the WHOLE task". Resist the first-slice reflex — a rushed start ships a half-task. Order by dependency (blockers first) and spike the unknown/risky parts before committing the plan.',
      'Define "done" for the whole task, not the first increment: name up front every case/state/path the finished task must cover so "done" can\'t silently shrink to the easy part. Compiles-but-doesn\'t-do-the-job, happy-path-only, or 1-of-N cases is NOT done ([[00b-self-verifiable-work]], graded by [[00d-turn-end-retrospective]]).',
      'The plan persists across turns — write it + remaining steps into TODO.md (manage_agent_todos / get_tasks) so it survives a context reset; carry and update it each turn, never re-derive from scratch. Prefer a thin end-to-end slice over broad half-built sprawl. Reconcile before closing: no complete_task until every planned step is genuinely [x] and verified; else the task stays open with an honest set_status.',
    ],
  },
  {
    id: '00f-swarm-orchestration', label: 'Swarm Orchestration', file: '00f-swarm-orchestration.md',
    keyRules: [
      'Your context window is finite — grinding a hard/broad/context-heavy task alone fills it and you DEGRADE mid-task (the out-of-context failure). Become the orchestrator: decompose ([[00e-long-horizon-planning]]) and delegate the heavy reading to workers who burn their OWN fresh contexts, keeping yours lean for the plan+steering. The tell "I\'m about to read a lot to answer this" = delegate it. Small edit/quick lookup → do inline; do NOT over-swarm.',
      'Stay lean: never pull raw file dumps/logs/large outputs into your own window — have workers read and return only the distilled result (conclusion/diff/artifact), in a shape you specify. Bias to parallel fan-out for independent sub-tasks. Spawn via your provider\'s subagent capability (native Task-style spawn) OR assign the slice as an office task to a teammate (send_message + their get_tasks; pick with list_agents/agent_profile/agent_tasks); collect returns with wait_for_events.',
      'Every worker gets a LIVING DOCUMENT at .autodev/swarm/<agent-slug>/AGENT.md (same durable .autodev/ tree as graph/issues; write with your file tools) — a self-contained brief AND running log: role, scope (owns/must-not-touch), real handles (paths/commands/acceptance) for a context-degraded reader ([[00c-verifiable-threads]]), input→output contract, reusable playbook, progress log. It PERSISTS → reuse+refine for recurring hard tasks. On return VERIFY don\'t rubber-stamp ([[00b-self-verifiable-work]]), reconcile vs plan, honest verdict ([[00d-turn-end-retrospective]]).',
      'For hard/high-stakes work don\'t trust a producer\'s "done ✅" — because you didn\'t read the source, a distilled return can hide SHALLOW work (skipped edge case, happy-path-only, unverified/subtly-wrong), and a producer grading itself is biased ([[00b-self-verifiable-work]]). Dispatch a CRITIC SWARM: SEPARATE workers, fresh independent context, prompted to REFUTE (diverse lenses — correctness/completeness/does-it-run/edge/security — not one generic "review this"). Producers build, critics attack. Each critic gets its own .autodev/swarm/<critic-slug>/AGENT.md with a rubric + output contract forcing SPECIFIC findings (file:line — what\'s wrong — severity, or "tried to break X via Y and could not"); forbid the "looks good" rubber stamp. Gate on the verdict: defects → revise → re-critique, accept ONLY when critics pass (severity/majority on disagreement). Proportional — don\'t critic-swarm trivial work; report what SURVIVED criticism vs merely producer-claimed ([[00d-turn-end-retrospective]]).',
    ],
  },
  {
    id: '00g-swarm-living-documents', label: 'Swarm Living Documents', file: '00g-swarm-living-documents.md',
    keyRules: [
      'A swarm worker\'s brief is not one file but a SET of small bounded living documents under .autodev/swarm/<agent-slug>/ — mirroring how a real autodev agent is structured: AGENT.md (role/scope/real-handles/input→output contract/playbook + an INDEX to siblings), SOUL.md (its identity+specialty, §0.0), MEMORY.md (durable facts it accrues, the delegation analog of §0.2 / .autodev/graph/), LESSONS.md (corrections + what worked/didn\'t, so the reusable role sharpens each pass), TODO.md (its task list + running progress log). The split IS the durability — each survives a context reset and loads on its own.',
      'The 16 KB-per-file cap is a HARD invariant — the same cap every profile pillar obeys. Living docs are read INTO context, so a file over the cap bloats the reader and defeats staying lean ([[00f-swarm-orchestration]]). When a file approaches the limit SPLIT it — by topic, by time (archive older MEMORY to dated sub-files), or into a linked sub-file — so every piece stays digestible. A doc crossing 16 KB is a bug, not housekeeping-for-later.',
      'Provision each worker with the FULL autodev profile (pillars 00a–00g + the rest), not a one-line prompt — so a worker is a real, fully-capable agent that can plan ([[00e-long-horizon-planning]]), verify ([[00b-self-verifiable-work]]), and even orchestrate its own sub-swarm, never a thin one-shot helper that grinds its slice in one window. How it arrives depends on the worker: a full autodev agent builds its own .autodev/profile/ on startup; a provider subagent inherits/references the parent\'s pillars; a seeded worker gets the set written under .autodev/swarm/<slug>/. Each profile section is itself its own md under 16 KB.',
    ],
  },
  {
    id: '00h-shared-skills', label: 'Shared Skills', file: '00h-shared-skills.md',
    keyRules: [
      'A skill is a reusable packaged capability the whole office shares — a SKILL.md in Anthropic Agent-Skills format (frontmatter `name` + a `description` that states WHAT it does and WHEN to use it, since the description is the load trigger: only it is always in context, the full SKILL.md loads on match, bundled scripts/refs load only when referenced). Author in the shared source `.autodev/skills/<slug>/SKILL.md` (same durable .autodev/ tree as graph/issues/swarm); it is deployed/synced to the provider load path `.claude/skills/<slug>/SKILL.md` (Claude loads there live; non-Claude providers get a prose fold into AGENTS.md).',
      'Discover before you re-invent ([[00a-proactive-discovery]]): before a hard/recurring task scan `.autodev/skills/` — read descriptions, load the matching SKILL.md, follow it. Create one when you crack a non-trivial RECURRING procedure a teammate would re-derive (distinct from Memory §0.2 = facts and Lessons = corrections; a skill is an executable PROCEDURE). Don\'t skill-ify one-offs — over-skilling is clutter. Keep SKILL.md focused and UNDER 16 KB; push long detail into bundled reference files.',
      'Skills are SHARED and LIVING: one agent\'s skill is available to all (synced office-wide via skill_update). When a skill you used is wrong/incomplete/improvable, UPDATE its SKILL.md in place — fix the step, add the gotcha/example, sharpen the description — never silently fork to v2. Verify a skill works and that its description matches its behaviour before sharing and after each update ([[00b-self-verifiable-work]]) — a skill whose description misfires is worse than none. Hand workers a skill in their brief and promote a proven swarm role into a shared skill when it recurs ([[00f-swarm-orchestration]], [[00g-swarm-living-documents]]).',
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
  {
    id: '20-project-graph', label: 'Project Graph — Durable Shared Memory', file: '20-project-graph.md',
    keyRules: [
      'Durable typed graph at .autodev/graph/ — shared across agents & sessions. Graph ≠ memory: structured, sourced, versioned facts, not prose. The agent forgets, the graph does not.',
      'At task start: graph_neighbors to recall what is known. While working: graph_add_node/add_edge to record claims (with source), decisions, artifacts (with version), evaluations (with rubric).',
      'Invariants: a claim needs source or inference:true; an artifact needs version; an evaluation needs rubric. Version facts with graph_supersede (never delete).',
    ],
  },
];

/** Returns all section IDs in order — useful as the default "all enabled" value. */
export const ALL_SECTION_IDS: string[] = PROFILE_SECTIONS.map(s => s.id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profileMediaDir(): string {
  // Resolve the profile media across the contexts this code runs in:
  //  • CLI native — __dirname is autodev-cli/out, so ../media/profile is the source.
  //  • Bundled VS Code extension — esbuild inlines this file, so __dirname is the
  //    extension's out/; its build copies the CLI media next to the bundle, so
  //    ../media/profile resolves there too.
  //  • Dev extension (tsc, not bundled) — loaded through the symlinked autodev-cli
  //    package; fall back to node_modules/autodev-cli/media/profile.
  const candidates = [
    path.join(__dirname, '..', 'media', 'profile'),
    path.join(__dirname, '..', 'node_modules', 'autodev-cli', 'media', 'profile'),
    path.join(__dirname, 'media', 'profile'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) { return c; } }
  return candidates[0];
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
 * Assemble PROGRAM.md as a compact **index**:
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
    '# AutoDev — PROGRAM.md',
    '',
    '> **Master index.** AGENTS.md / CLAUDE.md reference only this file; this file',
    '> describes and links every AutoDev reference. Each section below shows its key',
    '> rules inline and a `file://` link to the full section — **load a section only',
    '> when the task needs it** (small-context-friendly). The control spec and the',
    '> auto-mode loop tools are described at the end.',
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
    // The `file://` ref is what makes PROGRAM.md self-contained now that the
    // AGENTS.md block lists only PROGRAM.md: the full section loads on demand.
    const refLine = refPath ? `file://./${refPath.replace(/\\/g, '/')}` : '';
    // Hash over key rules + ref so the marker changes if either is updated
    const hash = md5(rulesLines + (refPath ?? ''));
    const block = [
      `<!-- AUTODEV:section:${section.id}:begin:md5=${hash} -->`,
      `### ${section.label}`,
      rulesLines,
      ...(refLine ? [`  ↳ full: ${refLine}`] : []),
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

  // Runtime references: the control spec + the auto-mode loop tools. PROGRAM.md
  // "describes all other references", so these belong here alongside the sections.
  body += [
    '',
    '---',
    '',
    '## Runtime — Control Spec & Auto-Mode Loop Tools',
    '',
    '- **Control spec** (optional): `file://./.autodev/CONTROL.md` — a per-project spec',
    '  (verify command, protected files, keep/revert rule, budget, escalation). When it',
    '  defines a `verify` command, the loop runs **verify_and_keep** after each task:',
    '  green → commit + mark `[x]`; red → auto-revert + reopen. With no control spec the',
    '  loop behaves normally. See skill `autodev-core-loop`.',
    '- **Auto-mode cadence tools** — the loop runs these itself every N tasks (set N in',
    '  settings); you do NOT hand-run them: **memory-checkpoint** (persist memory + living',
    '  docs) and **autolearn** (distil JOURNAL rows → LESSONS/skills/conventions).',
    '- **Journal** — records are appended deterministically (`journal_append`); do not',
    '  hand-format the table.',
    '',
  ].join('\n');

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
