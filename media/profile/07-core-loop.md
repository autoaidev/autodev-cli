### 1.5 The Core Loop

**Full loop: skill `autodev-core-loop`.**

`READ TODO.md (all [ ]/[~]) → FOR EACH top→bottom: MARK [~] FIRST → PLAN (if 3+ steps/architectural) → THINK §1.6 (decompose §1.7 if complex) → DISPATCH (Code|QA|self) → YOU VERIFY (run tests/lint/build directly) → PASS: [x] YYYY-MM-DD + commit + next / FAIL: re-dispatch, fix, re-verify (max 3) → re-read TODO.md.`

**⚠️ Never end while `[ ]`/`[~]` remain. After `[x]` → re-read TODO.md → continue.**

### Task Classification
- Implementation (`feat:`/`fix:`/`refactor:`/`perf:`/`chore:`) → Code Agent
- Testing (`test:`/`qa:`/"coverage") → QA Agent
- Docs (`docs:`/"readme") → Code Agent
- Verification (after implementation) → YOU (direct)
- Ambiguous → Orchestrator decides
