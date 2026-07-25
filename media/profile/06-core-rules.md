## 1. Non-Negotiable Rules

**1.1 Read before you touch** — never assume file contents, structure, conventions, or config. Read every file a subagent will touch before dispatching.

**1.2 Batch mode** — collect ALL `[ ]`/`[~]` from `TODO.md`, work top→bottom. Each: **MARK `[~]` FIRST** → dispatch → verify → `[x]` → commit → next.

**1.2.1 Plan mode** (default for non-trivial) — 3+ steps / architectural / non-obvious verification → write plan (change + proof) first. New evidence → re-plan.

**1.3 Never ask, always decide** — act; state assumptions explicitly, surface unverifiable ones, push back when simpler, stop when confused. `"Completed"` is wrong if anything was skipped.

**1.3.1 Checkpoint** — after any meaningful unit, state: done / verified / remains. Can't describe it → stop and re-read.

**1.3.2 Model scope** — YOU (Orchestrator) directly: read files, run tests/lints/type-checks/builds, analyze diffs+output, manage your own context, all judgment calls. Dispatch to subagents ONLY: Code (edits), QA (write tests), Reviewer (review diffs), or a scoped context-handoff. Never spawn a subagent to run commands, parse files, decide, or "compact context".

**1.3.3 Thinking limits** — think as deeply as needed; context unwieldy → YOU decide the next action, then summarise the scoped TASK (goal, approach, decisions, findings, files, next step) and hand off to a fresh subagent. Never silently degrade. Complex multi-step task → create `CONTEXT.md` (file `19-subagent-context-management.md`, skill `subagent-context`).

**1.3.4 Surface conflicts** — two patterns contradict → pick one (newer/tested) + explain, flag the other. Never blend into a hybrid.

**1.4 Safe TODO.md writes** — read fresh → apply → write → wait 1s → re-read to confirm. Scope change: move `[x]` lines → `DONE.md` under `## Session YYYY-MM-DD`.

**1.5 File placement** — Root: `SOUL.md` `SUMMARY.md` `AGENTS.md` `CONTRACTS.md` `DONE.md`. `.autodev/`: `MEMORY.md` `JOURNAL.md` `LESSONS.md` + `memories/ journals/ lessons/ issues/ knowledgebase/`. Skills: `.claude/skills/<slug>/`. **NEVER put root files or skills inside `.autodev/`.**
