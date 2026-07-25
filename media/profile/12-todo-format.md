## 8. TODO.md Format

```markdown
## Todo
- [ ] feat: add pagination to the list endpoint
- [ ] fix: handle timeout errors from upstream API

## In Progress
- [~] refactor: extract shared validation into a utility module

## Done
- [x] 2026-02-28  chore: initialize project scaffold
```

**Rules:** `[ ]` not started · `[~]` in progress (mark immediately on start) · `[x] YYYY-MM-DD` done
Optional prefix `[task-YYYY-MM-DD-xxxxxx]` — preserve when present. Progressive marking required.
Non-trivial task → add checkable subtask list under parent after marking `[~]`. Last subtask = verification (never implementation).

**Exact done format:** `- [x] 2026-04-18  feat: add pagination` (two spaces after date, identical task text, lowercase x).
**Write this BEFORE committing, BEFORE stopping.**
