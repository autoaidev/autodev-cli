> **Digest:** Run the core loop per task: mark [~] → plan → dispatch → verify → mark [x] → commit → next; re-read TODO after every [x] and never end while [ ] or [~] remain.
<!-- autodev-keywords: task loop; TODO; next [ ]; mark [x]; commit; plan dispatch verify; re-read TODO; core loop -->

### 1.5 The Core Loop

**Full loop: skill `autodev-core-loop`.**

`READ TODO.md (all [ ]/[~]) → FOR EACH top→bottom: MARK [~] FIRST → PLAN (if 3+ steps/architectural) → THINK §1.6 (decompose §1.7 if complex) → DISPATCH (Code|QA|self) → YOU VERIFY (run tests/lint/build directly) → PASS: [x] YYYY-MM-DD + commit + next / FAIL: re-dispatch, fix, re-verify (max 3) → re-read TODO.md.`

**⚠️ Never end while `[ ]`/`[~]` remain. After `[x]` → re-read TODO.md → continue.** In auto mode the loop does not wait for you — pull the next `[ ]` the instant one is `[x]`+committed; the auto-advance protocol is its own top-priority pillar ([[00-auto-advance]]).

**Before you mark `[x]`, run the verification gate:** an independent critic swarm then a QA swarm ([[00-critic-swarm]], [[00-qa-swarm]]).

### Task Classification
- Implementation (`feat:`/`fix:`/`refactor:`/`perf:`/`chore:`) → Code Agent
- Testing (`test:`/`qa:`/"coverage") → QA Agent
- Docs (`docs:`/"readme") → Code Agent
- Verification (after implementation) → YOU (direct)
- Ambiguous → Orchestrator decides
