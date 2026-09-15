#!/usr/bin/env node
/**
 * gen-autodev-skill — build-time generator for the single master `autodev`
 * Agent Skill (agentskills.io protocol).
 *
 * SINGLE SOURCE OF TRUTH: it reads every profile pillar's Digest (line 1) and
 * its `<!-- autodev-keywords: … -->` line (line 2) from `media/profile/<file>.md`,
 * plus the ordered PROFILE_SECTIONS metadata (id/label/file) from the compiled
 * `out/profileBuilder.js`, and emits `media/skills/autodev/SKILL.md`:
 *   - frontmatter: name=autodev + a curated ≤1024-char `description` (the trigger:
 *     one WHAT sentence + a WHEN clause packed with the top cross-domain keywords),
 *     plus a `metadata` map.
 *   - body (<16 KB, <500 lines): a short intro + a keyword ROUTING INDEX grouped by
 *     domain, each row → `.autodev/profile/<file>.md` (the path pillars deploy to in
 *     a live workspace via profileBuilder.deploySectionFile).
 *
 * This SUPPLEMENTS the always-loaded PROGRAM.md — it does not replace pillar
 * loading; it makes the `.autodev/profile/*` files loadable on demand via one
 * keyword-triggered skill.
 *
 * Idempotent: same inputs → byte-identical output. Wired into `npm run build`
 * (after tsc) and `prepublishOnly`. Fails loudly if any invariant is violated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'media', 'profile');
const OUT_DIR = path.join(ROOT, 'media', 'skills', 'autodev');
const OUT_FILE = path.join(OUT_DIR, 'SKILL.md');

const MAX_DESC = 1024;         // agentskills.io: description ≤ 1024 chars
const MAX_BODY_BYTES = 16 * 1024; // keep SKILL.md body under 16 KB
const MAX_BODY_LINES = 500;

// --- Load the ordered section list (id/label/file) from the compiled CLI. ----
let PROFILE_SECTIONS;
try {
  ({ PROFILE_SECTIONS } = require(path.join(ROOT, 'out', 'profileBuilder.js')));
} catch (err) {
  console.error(
    `gen-autodev-skill: could not load out/profileBuilder.js — run "tsc -p ./" first ` +
    `(the build wires this generator AFTER tsc). ${err.message}`,
  );
  process.exit(1);
}

// --- Domain grouping: pillar id → domain. Order of DOMAINS defines index order;
//     within a domain, PROFILE_SECTIONS order is preserved. Every section id must
//     map to exactly one domain (asserted below). --------------------------------
const DOMAINS = [
  ['Core loop & auto-advance', ['00-identity', '00-auto-advance', '07-core-loop', '12-todo-format', '08-thinking']],
  ['Done-gate: self-verify, critic & QA', ['00b-self-verifiable-work', '00-critic-swarm', '00-qa-swarm', '00i-qa-swarm', '00d-turn-end-retrospective']],
  ['Planning', ['00e-long-horizon-planning', '00m-autoplan', '00j-deferred-task-resolution']],
  ['Swarms & workflows', ['00f-swarm-orchestration', '00g-swarm-living-documents', '00k-internal-workflows', '09-parallel-panel', '19-subagent-context-management', '06-core-rules']],
  ['Memory, living docs & continuity', ['02-memory-mcp', '03-living-docs', '01-learning', '16-journal', '17-issue-tracking', '18-knowledgebase', '20-project-graph', '00l-compaction-continuity', '00n-context-checkpoints']],
  ['Skills', ['00h-shared-skills', '04-skill-files', '05-skill-creation']],
  ['Discovery & verification', ['00a-proactive-discovery', '10-codebase-verification', '11-git-debug-security']],
  ['Coordination, threads & identity', ['00c-verifiable-threads', '14-contracts', '15-soul']],
  ['Engineering principles', ['13-workflow-principles']],
];

// Curated priority keywords for the WHEN clause of the description (top
// cross-domain triggers, ordered by importance — greedily fit under 1024).
const PRIORITY_KEYWORDS = [
  'running the task loop', 'TODO', 'mark [x]', 'commit', 'auto mode',
  'advance to next task', "don't stall", 'keep going', 'before marking done',
  'review', 'critique', 'adversarial review', 'qa', 'test before done',
  'run it end-to-end', 'verify on the real product', 'objective check',
  'tests green', 'exit 0', 'HTTP 200', 'plan', 'break down', 'milestones',
  'harden the plan', 'autoplan', 'orchestrate', 'delegate', 'swarm',
  'subagents', 'fan-out', 'deterministic workflow', 'defer', 'blocked',
  'deferred task', 'save progress', 'resume', 'checkpoint', 'compaction',
  'memory', 'remember', 'recall', 'living docs', 'skill', '.claude/skills',
  'discovery sweep', 'startup', 'find work', 'contracts', 'email a teammate',
  'SOUL', 'identity', 'project graph', 'durable facts', 'subagent context',
];

// --- Read each pillar's Digest (line 1) + keywords (line 2). ------------------
function readPillar(file) {
  const p = path.join(PROFILE_DIR, file);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  if (!lines[0].startsWith('> **Digest:**')) {
    throw new Error(`${file}: line 1 is not a Digest — invariant broken`);
  }
  const digest = lines[0].replace(/^> \*\*Digest:\*\*\s*/, '').trim();
  let keywords = '';
  const m = (lines[1] || '').match(/^<!--\s*autodev-keywords:\s*([\s\S]*?)\s*-->\s*$/);
  if (m) { keywords = m[1].trim(); }
  if (!keywords) {
    throw new Error(`${file}: missing "<!-- autodev-keywords: … -->" on line 2`);
  }
  return { digest, keywords };
}

const byId = new Map(PROFILE_SECTIONS.map((s) => [s.id, s]));

// Validate the domain map covers every section exactly once.
const assigned = new Set();
for (const [, ids] of DOMAINS) {
  for (const id of ids) {
    if (!byId.has(id)) { throw new Error(`DOMAINS references unknown section id "${id}"`); }
    if (assigned.has(id)) { throw new Error(`section id "${id}" appears in more than one domain`); }
    assigned.add(id);
  }
}
for (const s of PROFILE_SECTIONS) {
  if (!assigned.has(s.id)) { throw new Error(`section "${s.id}" is not assigned to any domain in DOMAINS`); }
}

// --- Build the description (≤1024). -------------------------------------------
const WHAT =
  'The AutoDev autonomous-agent operating protocol: the per-task loop, auto-advance so you never stall, ' +
  'the critic-then-QA done-gate, long-horizon planning, swarms and deterministic workflows, memory and ' +
  'living documents, and self-verification before marking anything done.';

function buildDescription() {
  let kws = [...PRIORITY_KEYWORDS];
  const compose = (list) => `${WHAT} Trigger when a task involves: ${list.join('; ')}.`;
  let desc = compose(kws);
  while (desc.length > MAX_DESC && kws.length > 4) {
    kws.pop();
    desc = compose(kws);
  }
  if (desc.length > MAX_DESC) { desc = desc.slice(0, MAX_DESC); }
  return desc;
}
const description = buildDescription();

// --- Build the body (routing index). -----------------------------------------
const bodyLines = [];
bodyLines.push('# AutoDev protocol router');
bodyLines.push('');
bodyLines.push(
  'This skill routes you to the AutoDev protocol files already in this workspace under ' +
  '`.autodev/profile/`. They are also summarized always-on in `.autodev/PROGRAM.md`; this ' +
  'skill is the keyword-triggered index to the FULL text of each pillar. When a task matches ' +
  'one of the topics below, READ the linked file and follow it.',
);
bodyLines.push('');
bodyLines.push('## Routing index');
bodyLines.push('');
for (const [domain, ids] of DOMAINS) {
  bodyLines.push(`### ${domain}`);
  bodyLines.push('');
  // Preserve PROFILE_SECTIONS order within the domain.
  const ordered = PROFILE_SECTIONS.filter((s) => ids.includes(s.id));
  for (const s of ordered) {
    const { keywords } = readPillar(s.file);
    bodyLines.push(`- **${s.label}** — keywords: ${keywords} → read \`.autodev/profile/${s.file}\``);
  }
  bodyLines.push('');
}
bodyLines.push('---');
bodyLines.push('');
bodyLines.push(
  'If a `.autodev/profile/<file>.md` link is missing (older workspace), the same content is ' +
  'under its section heading in `.autodev/PROGRAM.md`. This skill supplements — never replaces — ' +
  'the always-loaded PROGRAM.md.',
);
bodyLines.push('');

const body = bodyLines.join('\n');

// --- Frontmatter + assemble. --------------------------------------------------
const frontmatter = [
  '---',
  'name: autodev',
  `description: ${description}`,
  'metadata:',
  '  source: autodev-cli',
  '  generated: "true"',
  'license: MIT',
  '---',
  '',
].join('\n');

const out = frontmatter + body;

// --- Validate invariants (self-check; no external validator needed). ----------
const problems = [];
if (description.length === 0) { problems.push('description is empty'); }
if (description.length > MAX_DESC) { problems.push(`description ${description.length} > ${MAX_DESC}`); }
const bodyBytes = Buffer.byteLength(body, 'utf8');
if (bodyBytes >= MAX_BODY_BYTES) { problems.push(`body ${bodyBytes} bytes >= ${MAX_BODY_BYTES}`); }
const bodyLineCount = body.split('\n').length;
if (bodyLineCount >= MAX_BODY_LINES) { problems.push(`body ${bodyLineCount} lines >= ${MAX_BODY_LINES}`); }
// name must match dir
if (path.basename(OUT_DIR) !== 'autodev') { problems.push('output dir is not named "autodev"'); }
// every referenced .autodev/profile path must map to a real PROFILE_SECTIONS file
for (const s of PROFILE_SECTIONS) {
  if (!out.includes(`.autodev/profile/${s.file}`)) { problems.push(`index missing row for ${s.file}`); }
  if (!fs.existsSync(path.join(PROFILE_DIR, s.file))) { problems.push(`source pillar missing: ${s.file}`); }
}
if (problems.length) {
  console.error('gen-autodev-skill: FAIL —\n  ' + problems.join('\n  '));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, out, 'utf8');
console.log(
  `gen-autodev-skill: wrote ${path.relative(ROOT, OUT_FILE)} — ` +
  `description ${description.length}/${MAX_DESC} chars, body ${bodyBytes} bytes / ${bodyLineCount} lines, ` +
  `${PROFILE_SECTIONS.length} pillars indexed.`,
);

// Keep the helper importable if ever needed by a test.
export { description, body, OUT_FILE };
