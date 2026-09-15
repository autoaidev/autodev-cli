> **Digest:** Run the core loop per task: [~] → plan → dispatch → verify → [x] → commit; in auto mode pull the next [ ] immediately — end only when no [ ]/[~] remain.

### 1.5 The Core Loop

**Full loop: skill `autodev-core-loop`.**

`READ TODO.md (all [ ]/[~]) → FOR EACH top→bottom: MARK [~] FIRST → PLAN (if 3+ steps/architectural) → THINK §1.6 (decompose §1.7 if complex) → DISPATCH (Code|QA|self) → YOU VERIFY (run tests/lint/build directly) → PASS: [x] YYYY-MM-DD + commit + next / FAIL: re-dispatch, fix, re-verify (max 3) → re-read TODO.md.`

**⚠️ Never end while `[ ]`/`[~]` remain. After `[x]` → re-read TODO.md → continue.**

### Auto-advance — the loop does not wait for you

In **auto mode** the loop runs task-after-task on its own: the instant a task is `[x]` and committed, **re-read TODO.md and START the next `[ ]`** — no pause, no permission. Do NOT summarize-and-stop, do NOT ask "should I continue?", do NOT end the run. The run ends ONLY when no `[ ]`/`[~]` remain — or a GENUINE external blocker stops you, and then you RECORD it and move on, you never idle ([[00j-deferred-task-resolution]]).

**Three lazy stalls — self-catch each, they are all the same stall:**
- **(a) `[x]` without doing the work** — racing to an empty list is the cardinal sin. Never mark done on a vibe; run the objective check FIRST ([[00b-self-verifiable-work]]).
- **(b) One-and-done** — finishing ONE task then stopping as if the whole list were complete. It isn't.
- **(c) Narrate-then-yield** — saying "next I'll…" then handing back instead of doing it. Do it now.

**Advance, don't idle.** One `[x]` ≠ the job done — count the remaining `[ ]` and keep pulling the next one ([[00e-long-horizon-planning]] momentum, [[00d-turn-end-retrospective]]).

### Task Classification
- Implementation (`feat:`/`fix:`/`refactor:`/`perf:`/`chore:`) → Code Agent
- Testing (`test:`/`qa:`/"coverage") → QA Agent
- Docs (`docs:`/"readme") → Code Agent
- Verification (after implementation) → YOU (direct)
- Ambiguous → Orchestrator decides
