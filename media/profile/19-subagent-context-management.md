---
title: "Subagent Context Management"
description: "When and how to spawn subagents; how to maintain context during deep tasks; ensuring subagents get proper briefs"
---

# Subagent Context Management

**Full decision tree, CONTEXT.md template, and briefing template: skill `subagent-context`.**

**You own your context.** Subagents are NOT for compacting your context (they compact their own empty context — infinite loop), deciding what to do next, running commands (tests/lints/builds), or reading/parsing files. Those are all YOU.

**Subagents ARE for:** scoped implementation (Code), writing new tests (QA), diff review (Reviewer), architectural design (Architect), or a context handoff when your own context is unwieldy AND you have already made the decisions.

**Before spawning any subagent:**
1. Decide the EXACT next action yourself — never hand off "figure out what to do".
2. Write a detailed brief: MISSION (one sentence) · CONTEXT (only what's relevant: main goal, decisions already made, relevant files + why) · WHAT TO IMPLEMENT (exact approach, files to edit, patterns to follow, DO/DON'T) · DONE CRITERIA.
3. Tell the subagent NOT to run tests/lints/builds or update `TODO.md` — the Orchestrator does that.

**After it returns:** YOU verify (tests, lint, diff review) and update state.

**Context handoff** — spawn only when: 20+ exchanges on one task · going in circles · context full of stale exploration · a complex multi-file change with decisions already made. NOT for: running a test, deciding the next step, "compacting", or 1–3 simple edits (do those yourself).

**CONTEXT.md** — for complex multi-step tasks create `CONTEXT.md` (main goal · key decisions · files/approach · progress tracker · subagent spawns · blockers) to avoid losing the main goal during deep work. Update it before/after every spawn; checkpoint against it (can I state the goal in one sentence? do I know the next action? have I strayed?). Archive to `DONE_CONTEXT_YYYY-MM-DD.md` when done.

Integrates with skill `autodev-core-loop` — the loop stays primary; never let subagent management override it.
