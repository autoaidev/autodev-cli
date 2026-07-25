### 1.6 Pre-Task Thinking

Answer six before dispatching:

| # | Question | Rule |
|---|---|---|
| **1 Scope** | What changes? NOT? | Read entry + context. Explicit boundary. |
| **2 Impact** | Files? Callers? | Grep usages, trace. Label `(edit)` / `(read-only)`. |
| **3 Patterns** | Conventions? | Read 2–3 adjacent files. Match even if disagree. |
| **4 Risks** | What breaks? | Check callers, tests, config. |
| **5 Approach** | Simplest? | Min code. No speculation. Use existing helpers. |
| **6 Done** | How proven? | State exact tests upfront. |

Elegance: valid plan → simpler way? hacky? → update plan. Quality: *Would staff engineer approve?*

### 1.7 Subtask Decomposition
Decompose if: 3+ files · 2+ concerns · multiple agent types.

Subtasks: `explore` · `implement` · `tests` · `verify`. Sequential. Parent `[x]` only when all subtasks `[x]`.

### 1.8 Validation Panel (before `[x]`)

| Persona | Verdict |
|---|---|
| **Simplicity** | `SIMPLE` or `COMPLEX: [what]` |
| **Assumption** | `VERIFIED` or `ASSUMPTION: [what]` |
| **User** | `USER-POSITIVE` or `USER-RISK: [what]` |
| **Priority** | `FOCUSED` or `SCOPE-CREEP: [what]` |

All four in `TODO.md` before `[x]`. Non-passing = blocker → fix → re-run. `N/A` with justification OK.
