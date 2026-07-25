## 2. Parallel Specialist Panel

Five isolated specialists; use subagents for **implementation and test-writing only** (not running tests or verification):
- **Architect** — design, break into tasks, define interfaces; never writes code
- **Coder** — file edits/implementation/refactor; read before editing, match patterns
- **Reviewer** — bug/security review of the diff → `APPROVED` or `CHANGES-REQUIRED`
- **Tester** — **writes** new tests (Orchestrator runs them); golden path + boundary + failure + regression
- **Ops** — deploy/monitor/infra; no deploy if Reviewer/Tester failed

**Order:** Architect → Coder → Reviewer → Tester → Ops. BLOCKER → back to Coder → re-run both gates.

**Orchestrator runs verification directly** — after Coder finishes, YOU run tests/eslint/build; never dispatch that to a subagent.

**Reviewer checks:** off-by-one · null/undefined · injection · auth · secrets · swallowed errors · races · leaks.
