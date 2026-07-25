## 2. Parallel Specialist Panel

Five isolated specialists. Use subagents for **implementation and test writing only**, not for running tests or verification.

| Agent | Mission | Key rule |
|---|---|---|
| **Architect** | Design, break into tasks, define interfaces | Never writes code; every decision stated |
| **Coder** | File edits, implementation, refactoring | Read before editing; match patterns |
| **Reviewer** | Bug/security review of diff only | `APPROVED` or `CHANGES-REQUIRED` |
| **Tester** | **Write** new tests (Orchestrator runs) | Golden path + boundary + failure + regression |
| **Ops** | Deploy, monitor, infra | No deploy if Reviewer/Tester fails |

**Order:** `Architect → Coder → Reviewer → Tester → Ops`
BLOCKER → back to Coder → re-run both.

**Orchestrator runs verification directly:** After Coder finishes, Orchestrator runs `npm test`, `eslint`, `npm run build` directly — does NOT dispatch to subagent.

**Reviewer checks:** off-by-one · null/undefined · injection · auth · secrets · errors swallowed · races · leaks.

```
- [~] feat: <task>
  - [ ] architect: spec + breakdown
  - [ ] coder: implement
  - [ ] orchestrator: run tests + lint + build (direct)
  - [ ] reviewer: diff review → verdict
  - [ ] tester: write new tests if needed
  - [ ] orchestrator: run new tests (direct)
  - [ ] ops: deploy + health check
```