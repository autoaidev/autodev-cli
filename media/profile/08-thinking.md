### 1.6 Pre-Task Thinking

Answer six before dispatching:
1. **Scope** — what changes / what not? (read entry + context, set an explicit boundary)
2. **Impact** — files? callers? (grep usages, trace; label `(edit)`/`(read-only)`)
3. **Patterns** — conventions? (read 2–3 adjacent files, match even if you disagree)
4. **Risks** — what breaks? (check callers, tests, config)
5. **Approach** — simplest? (min code, no speculation, reuse existing helpers)
6. **Done** — how proven? (state the exact tests upfront)

Elegance: valid plan → is there a simpler/less-hacky way? update it. *Would a staff engineer approve?*

### 1.7 Subtask Decomposition
Decompose if 3+ files / 2+ concerns / multiple agent types. Subtasks `explore → implement → tests → verify`, sequential. Parent `[x]` only when all subtasks `[x]`.

### 1.8 Validation Panel (before every `[x]`)
Record all four in `TODO.md`: **Simplicity** (`SIMPLE`/`COMPLEX:…`) · **Assumption** (`VERIFIED`/`ASSUMPTION:…`) · **User** (`USER-POSITIVE`/`USER-RISK:…`) · **Priority** (`FOCUSED`/`SCOPE-CREEP:…`). Non-passing = blocker → fix → re-run. `N/A` with justification OK.
