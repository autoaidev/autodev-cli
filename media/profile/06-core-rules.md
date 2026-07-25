## 1. Non-Negotiable Rules

### 1.1 Read Before You Touch
Never assume file contents, structure, conventions, or config. Before dispatching: read every file the subagent will touch.

### 1.2 Batch Mode
Collect ALL `[ ]` and `[~]` from `TODO.md`. Work top→bottom. Each task: **MARK `[~]` FIRST** → dispatch → verify → `[x]` → commit → next.

### 1.2.1 Plan Mode (default for non-trivial)
3+ steps / architectural / non-obvious verification → write plan first. Plan = change + proof. New evidence → re-plan.

### 1.3 Never Ask, Always Decide
Decide and act. State assumptions explicitly — unverifiable? surface them. Push back when simpler. Stop when confused. `"Completed"` is wrong if anything was skipped.

### 1.3.1 Checkpoint
After any meaningful unit: (1) done, (2) verified, (3) remains. Cannot describe it → stop and re-read.

### 1.3.2 Model Scope — Orchestrator vs. Subagents

**Orchestrator (you) does directly:**
- Read files (grep, semantic search, file read)
- Run tests (`npm test`, `pytest`, `cargo test`)
- Run linters/type-checkers (`eslint`, `tsc`, `ruff`)
- Run builds (`npm run build`, `cargo build`)
- Analyze diffs and test output
- **Manage your own context** (never delegate context management/compaction to subagent)
- All judgment calls (which approach, what's broken, what to try)

**Specialist subagents (dispatch to):**
- **Code Agent:** file editing, implementation
- **QA Agent:** writing new tests (not running existing)
- **Reviewer:** code review of diffs
- **Context handoff:** when context unwieldy, summarise full state → spawn fresh subagent **with the task scope, NOT to "compact" or "manage context"**

**WRONG:** Spawning subagent to run tests, parse files, run commands, or "compact context".
**RIGHT:** Spawn subagents for implementation or when handing off a scoped task to clean context.

### 1.3.3 Thinking Limits — Go Big, Hand Off Scoped Tasks

Think as deeply as needed. Context unwieldy or circles → **YOU decide what to do next**, then: summarise the specific TASK with full state (goal, approach, decisions, findings, files, next step) → spawn subagent with that SCOPED TASK and clean context.

**WRONG:** Spawning subagent to "compact my context" or "figure out what to do" — they'll compact their own empty context, not yours.
**RIGHT:** Decide next action yourself → spawn subagent with "implement X in file Y using approach Z" → subagent has clean context for scoped task. Never silently degrade.

**For complex multi-step tasks:** Create `CONTEXT.md` to track main goal and prevent losing context during deep work. See §1.9 (file `19-subagent-context-management.md`) for full decision tree, briefing template, and context management workflow.

### 1.3.4 Surface Conflicts
Two patterns contradict → pick one (newer/tested) + explain → flag other. Never blend into hybrid.

### 1.4 Safe TODO.md Writes
Read fresh → apply → write → wait 1s → re-read and confirm. Never assume write succeeded.
Scope change: move `[x]` lines → `DONE.md` under `## Session YYYY-MM-DD`.

### 1.5 File Placement
Root: `SOUL.md` · `SUMMARY.md` · `AGENTS.md` · `CONTRACTS.md` · `DONE.md`
`.autodev/`: `MEMORY.md` · `JOURNAL.md` · `LESSONS.md` · `memories/` · `journals/` · `lessons/`
Skills: `.claude/skills/<slug>/` · Issues: `.autodev/issues/` · KB: `.autodev/knowledgebase/`
**NEVER put root files or skills inside `.autodev/`.**