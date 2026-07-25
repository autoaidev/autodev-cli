---
title: "Subagent Context Management"
description: "When and how to spawn subagents; how to maintain context during deep tasks; ensuring subagents get proper briefs"
---

# Subagent Context Management

## Critical Principle: You Own Context

**YOU (the Orchestrator) manage your own context.** Subagents are NOT for:
- Compacting your context (they compact theirs, not yours = infinite loop)
- Figuring out what to do next (you decide, then hand off)
- Running commands (tests, lints, builds)
- Reading files or parsing output

**Subagents ARE for:**
- Scoped implementation work with clean context
- Complex creative tasks that benefit from fresh context
- Parallel specialist work (Code, QA, Reviewer)

---

## When to Spawn a Subagent: Decision Tree

```
┌─────────────────────────────────────────────────────────────┐
│ IS THE TASK...                                              │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
     ┌────────────────────────────────────┐
     │ A shell command that returns text? │  → YES → YOU RUN IT (no subagent)
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ Reading/parsing files or output?   │  → YES → YOU DO IT (no subagent)
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ A judgment call or decision?       │  → YES → YOU DECIDE (no subagent)
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ "Manage my context" or "compact"?  │  → YES → YOU HANDLE (never subagent!)
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ Implementation (editing files)?    │  → YES → Spawn Code Agent
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ Writing new test files?            │  → YES → Spawn QA Agent
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ Reviewing code/diff?               │  → YES → Spawn Reviewer Agent
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌────────────────────────────────────┐
     │ Architectural design?              │  → YES → Spawn Architect Agent
     └────────────────────────────────────┘
          │ NO
          ▼
     ┌──────────────────────────────────────────────────────────┐
     │ Deep multi-step implementation requiring fresh context?  │
     │ (your context is unwieldy/circular)                      │  → YES → See "Context Handoff" below
     └──────────────────────────────────────────────────────────┘
          │ NO
          ▼
     [YOU DO IT DIRECTLY]
```

---

## Context Handoff: When Your Context Is Unwieldy

### Signs You Need a Context Handoff

- ✅ You've been working on the same task for 20+ exchanges
- ✅ You're going in circles (repeating same analysis)
- ✅ Your context is full of irrelevant exploration from earlier
- ✅ You need to implement a complex multi-file change
- ✅ You've made the key decisions and need clean context to execute

### Signs You DON'T Need a Context Handoff

- ❌ You just need to run a test (`npm test` → run it yourself)
- ❌ You need to decide what to do next (you decide, don't delegate)
- ❌ You want to "compact" your context (manage it yourself)
- ❌ The task is 1-3 simple file edits (do it yourself or use Code Agent)
- ❌ You haven't decided on the approach yet (decide first, then hand off)

### How to Do a Context Handoff

**BEFORE spawning subagent:**

1. **Update CONTEXT.md** (see template below) with:
   - Main task goal
   - Key decisions made
   - Files/modules involved
   - Current status
   - What remains

2. **Decide the EXACT next action** — never hand off "figure out what to do"

3. **Write a detailed subagent brief** (see "Briefing Template" below)

4. **Spawn subagent with scoped task** — not "do everything" but "implement X using Y"

**AFTER subagent returns:**

1. **Update CONTEXT.md** with what was completed
2. **Verify the result yourself** (run tests, check diffs)
3. **Continue to next step** or mark task [x]

---

## CONTEXT.md Template

Create `CONTEXT.md` in your workspace root when starting complex multi-step tasks:

```markdown
# CONTEXT.md — Main Task Tracking

> **Purpose:** Keep track of the main task goal and prevent getting lost in deep subtasks.
> **Update:** After every major decision, subagent spawn, or context shift.

---

## Main Task

**Goal:** [One-sentence description of the main task]

**Status:** [Not Started / In Progress / Blocked / Completed]

**TODO.md Task Line:** 
```
- [~] feat: implement user authentication system
```

---

## Key Decisions Made

1. **[Date/Time]** Decision: [What was decided]
   - Reasoning: [Why this choice]
   - Alternative considered: [What was rejected and why]

2. **[Date/Time]** Decision: ...

---

## Architecture/Approach

[High-level description of the chosen approach]

**Files/Modules Involved:**
- `src/auth/login.ts` — handles login flow
- `src/auth/session.ts` — manages session state
- `src/api/auth-routes.ts` — API endpoints

**Key Patterns/Conventions:**
- Using JWT for tokens
- Sessions stored in Redis
- Following existing error handling pattern from `src/errors/`

---

## Progress Tracker

### Completed
- [x] 2026-05-25  Researched existing auth patterns in codebase
- [x] 2026-05-25  Decided on JWT + Redis approach
- [x] 2026-05-25  Spawned Code Agent to implement login.ts

### In Progress
- [~] Verify login.ts implementation
- [~] Run integration tests

### Remaining
- [ ] Implement session.ts
- [ ] Implement auth-routes.ts
- [ ] Add integration tests
- [ ] Update documentation

---

## Subagent Spawns

### Spawn 1: Code Agent — Implement login.ts
**When:** 2026-05-25 14:30
**Brief:** [See full brief below]
**Result:** Implemented login.ts with JWT generation
**Verified:** ✅ Tests pass, linter clean

### Spawn 2: QA Agent — Write integration tests
**When:** 2026-05-25 15:00
**Brief:** [See full brief below]
**Result:** [Pending]
**Verified:** [Pending]

---

## Blockers / Issues

- **[Date]** Blocker: [Description]
  - Status: [Open / Resolved]
  - Resolution: [How it was resolved]

---

## Context Checkpoints

Use these checkpoints to verify you're still on track:

1. **Can you state the main goal in one sentence?** [Yes/No - if no, re-read above]
2. **Do you know the next concrete action?** [Yes/No - if no, review Progress Tracker]
3. **Have you strayed into unrelated work?** [Yes/No - if yes, refocus on main goal]
4. **Is there a clearer path than current approach?** [Yes/No - if yes, update Decisions]

---

## Notes / Learnings

[Add any important discoveries, gotchas, or learnings that should be remembered]

```

---

## Subagent Briefing Template

When spawning a subagent for a complex task, use this template:

```markdown
# Subagent Brief: [Agent Type] — [Task Summary]

## MISSION (one sentence)
[Exactly what this subagent must accomplish]

## CONTEXT
[Only the relevant context — not your entire history]

**Main Task:** [Link back to the overall goal]

**Decisions Already Made:**
- [Key decision 1]
- [Key decision 2]

**Files/Modules Relevant to This Subtask:**
- `path/to/file.ts` — [why relevant]
- `path/to/test.ts` — [why relevant]

## WHAT TO IMPLEMENT

**Goal:** [Specific implementation goal]

**Approach:** [The exact approach to use — no ambiguity]
- Step 1: [Concrete action]
- Step 2: [Concrete action]
- Step 3: [Concrete action]

**Files to Edit:**
1. `path/to/file1.ts`
   - Add: [specific functionality]
   - Modify: [specific section]
   - Use pattern: [reference to existing pattern]

2. `path/to/file2.ts`
   - Add: [specific functionality]
   
**Patterns to Follow:**
- Error handling: Use `src/errors/AppError.ts` pattern
- Testing: Follow `__tests__/example.test.ts` structure
- Imports: Use absolute paths from `src/`

**DO:**
- Follow existing code style in the files
- Add JSDoc comments for public functions
- Write type-safe TypeScript (no `any`)
- Handle errors explicitly

**DON'T:**
- Change unrelated code
- Add libraries without checking existing stack
- Skip edge case handling
- Leave TODOs in production code

## DONE CRITERIA

This subtask is complete when:
1. [Specific criterion 1]
2. [Specific criterion 2]
3. [Specific criterion 3]
4. All edits are syntactically valid (no compilation errors)

## AFTER YOU'RE DONE

Return:
1. **Files changed:** List of file paths
2. **Summary:** What was implemented (2-3 sentences)
3. **Any issues:** Blockers, ambiguities, or decisions made

DO NOT:
- Run tests (orchestrator does this)
- Run linters (orchestrator does this)
- Verify the full feature (orchestrator does this)
- Update TODO.md (orchestrator does this)
```

---

## Anti-Patterns: NEVER Do These

### ❌ WRONG: Spawning subagent to compact context

```
❌ "My context is full. Let me spawn a subagent to continue."
```

**Why wrong:** The subagent starts with EMPTY context. It will compact its own empty context, not yours. Infinite loop.

**✅ RIGHT:** YOU decide what to keep. Update CONTEXT.md. Summarize decisions. THEN spawn subagent with scoped task.

---

### ❌ WRONG: Spawning subagent to decide next step

```
❌ "I'm not sure what to do next. Let me spawn a subagent to figure it out."
```

**Why wrong:** YOU are the orchestrator. YOU make decisions. Subagents execute scoped tasks.

**✅ RIGHT:** Re-read CONTEXT.md. Review Progress Tracker. Decide next action. THEN spawn subagent with specific task.

---

### ❌ WRONG: Spawning subagent to run tests

```
❌ "Let me spawn a subagent to run `npm test` and tell me the results."
```

**Why wrong:** Running tests is a deterministic shell command. You run it directly.

**✅ RIGHT:** Run `npm test` yourself. Analyze output yourself. Decide on fix. THEN spawn Code Agent to implement fix.

---

### ❌ WRONG: Vague subagent brief

```
❌ "Implement the authentication feature. Figure out the best approach."
```

**Why wrong:** Subagent doesn't have your context. It will re-explore everything you already researched. Wastes tokens and time.

**✅ RIGHT:** 
- YOU decide the approach (JWT + Redis)
- YOU identify files to edit (`login.ts`, `session.ts`)
- YOU specify the pattern to follow (existing error handling)
- THEN spawn subagent with detailed brief (see template above)

---

## Workflow: Managing Context in Complex Tasks

```
┌────────────────────────────────────────────────────────────────┐
│ START: Complex multi-step task                                 │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. CREATE CONTEXT.md                                           │
│    - Write main goal                                           │
│    - Set up Progress Tracker                                   │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. RESEARCH & DECIDE                                           │
│    - Read relevant files                                       │
│    - Explore codebase                                          │
│    - Make key decisions                                        │
│    - UPDATE CONTEXT.md with decisions                          │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. BREAK DOWN INTO SUBTASKS                                    │
│    - Write subtasks in TODO.md                                 │
│    - Update CONTEXT.md Progress Tracker                        │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. FOR EACH SUBTASK:                                           │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4a. Check: Can I do this directly? (1-3 file edits) │    │
│    │     → YES: Do it yourself                            │    │
│    │     → NO: Continue to 4b                             │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4b. Write detailed subagent brief (use template)    │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4c. Spawn subagent with scoped task                 │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4d. UPDATE CONTEXT.md with spawn details           │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4e. Receive result from subagent                    │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4f. YOU verify (tests, lint, build)                 │    │
│    └─────────────────────────────────────────────────────┘    │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ 4g. UPDATE CONTEXT.md Progress Tracker              │    │
│    └─────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. CHECKPOINT: Review CONTEXT.md                               │
│    - Am I still on track for main goal?                        │
│    - Have I strayed into unrelated work?                       │
│    - Is the approach still valid?                              │
└────────────────────────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│ 6. COMPLETE: All subtasks done                                 │
│    - Mark main task [x]                                        │
│    - Archive CONTEXT.md → DONE_CONTEXT_YYYY-MM-DD.md          │
│    - Commit                                                    │
└────────────────────────────────────────────────────────────────┘
```

---

## Quick Reference: Subagent Dispatch Rules

| Task Type | Who Does It | Notes |
|-----------|-------------|-------|
| Run `npm test` | **YOU** | Never spawn subagent for shell commands |
| Run `eslint` | **YOU** | Never spawn subagent for linters |
| Run `npm run build` | **YOU** | Never spawn subagent for builds |
| Read files | **YOU** | Never spawn subagent to read/parse |
| Grep/search codebase | **YOU** | Use grep_search/semantic_search directly |
| Analyze test output | **YOU** | Never spawn subagent to interpret output |
| Decide what to do next | **YOU** | Never spawn subagent to make decisions |
| Manage context | **YOU** | Never spawn subagent to compact YOUR context |
| Edit 1-3 files (simple) | **YOU** | Direct edits faster than subagent |
| Edit 5+ files (complex) | **Code Agent** | Spawn with detailed brief |
| Multi-file refactor | **Code Agent** | One file at a time, or spawn with full context |
| Write new test files | **QA Agent** | Spawn with spec and patterns to follow |
| Review code/diff | **Reviewer Agent** | Spawn after changes complete |
| Architectural design | **Architect Agent** | Spawn with requirements and constraints |
| Context handoff | **Code Agent** | When YOUR context unwieldy + decisions made |

---

## Success Metrics

You're using subagents correctly when:

✅ Subagents receive detailed, specific briefs (not "figure it out")  
✅ You update CONTEXT.md before and after subagent spawns  
✅ You never spawn subagents to run commands or read files  
✅ You verify all subagent work yourself (tests, lint, diff review)  
✅ You stay on track with the main goal (no context drift)  
✅ Subagents work on scoped tasks with clean context  
✅ You make all decisions; subagents execute decisions  

You're doing it WRONG when:

❌ Spawning subagent to "compact my context"  
❌ Spawning subagent to "figure out what to do"  
❌ Spawning subagent to run tests or linters  
❌ Giving vague briefs like "implement feature X"  
❌ Losing track of main goal after deep subtasks  
❌ Forgetting to update CONTEXT.md  
❌ Repeating research that you already did  

---

## Integration with Core Loop

This skill integrates with the **autodev-core-loop** skill:

- **Before Step 4 (THINK & PLAN):** Check if this is a context-heavy task → create CONTEXT.md
- **During Step 4 (THINK & PLAN):** Make decisions, update CONTEXT.md
- **During Step 5 (DISPATCH):** Use briefing template for complex tasks
- **After Step 6 (RECEIVE):** Update CONTEXT.md with result
- **During Step 7 (VERIFY):** Reference CONTEXT.md to ensure main goal still on track
- **After Step 8 (RE-READ TODO.md):** Check CONTEXT.md before picking next task

**Never let subagent management override the core loop. The loop is primary.**


