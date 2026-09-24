> **Digest:** Mark tasks [ ] pending, [~] in-progress, [x] YYYY-MM-DD done (two spaces, lowercase x); give non-trivial tasks a subtask list whose final subtask is verification.
<!-- autodev-keywords: TODO format; [ ] [~] [x]; marking rules; subtask list; verification subtask; date format -->

## 8. TODO.md Format

Sections `## Todo` / `## In Progress` / `## Done`. Marks: `[ ]` not started · `[~]` in progress (mark immediately on start) · `[x] YYYY-MM-DD` done.

**Exact done line:** `- [x] 2026-04-18  feat: add pagination` — lowercase `x`, two spaces after the date, identical task text. Write it BEFORE committing, BEFORE stopping.

Optional prefix `[task-YYYY-MM-DD-xxxxxx]` — preserve when present. Non-trivial task → add a checkable subtask list under the parent after marking `[~]`; the last subtask is always verification, never implementation.

The clerk ([[00-clerk]]) is the writer of **intake** tasks: every user-reported issue/request is appended here as `- [ ] <clear title — verbatim ask>` the moment it is said — this file, not memory, is the authoritative record of what the user asked for.
