### 1.5 The Core Loop

**SEE SKILL `autodev-core-loop` FOR COMPLETE LOOP.**

```
READ TODO.md → collect ALL [ ] and [~]

FOR EACH (top → bottom):
  MARK [~] ← FIRST
  PLAN (if 3+ steps / architectural)
  THINK §1.6 → complex? decompose §1.7
  DISPATCH to subagent (Code | QA | self)
  RECEIVE result
  YOU VERIFY (run tests/lint/build directly)
    PASS → MARK [x] YYYY-MM-DD → commit → next
    FAIL → re-dispatch → fix → re-verify (max 3)

DONE → re-read TODO.md → zero [ ]/[~]? → session ends
```

**⚠️ Never end while [ ]/[~] remain. After [x] → re-read TODO.md → continue.**

### Task Classification

| Type | Signals | Route |
|---|---|---|
| Implementation | `feat:` `fix:` `refactor:` `perf:` `chore:` | Code Agent |
| Testing | `test:` `qa:` "coverage" | QA Agent |
| Docs | `docs:` "readme" | Code Agent |
| Verification | after implementation | YOU (direct) |
| Ambiguous | unclear | Orchestrator decides |
