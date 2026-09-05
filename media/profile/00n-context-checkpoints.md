## 0.0n Context Checkpoints — Save & Restore Your Working State

**When to use:** The user says *"save progress/state/my work/context"*, or you want to bank where you are → run **Context-Save** · The user says *"resume where I left off / restore context / where was I / pick up where I left off"* → run **Context-Restore** · Also across sessions, across git worktrees, and at the compaction boundary ([[00l-compaction-continuity]], §0.0l). **A checkpoint is a durable, browsable, timestamped snapshot of your working state so ANY future session or worktree can resume without losing a beat.**

`PRE_COMPACT.md` is the fast single-slot snapshot for THIS thread across ONE compaction — overwritten each time, transient ([[00l-compaction-continuity]], §0.0l). Context Checkpoints are its **cross-session counterpart**: an append-only history of state you can list, pick from, and rehydrate days later, on another branch, in another worktree. Same instinct — write for a degraded future reader ([[00c-verifiable-threads]], §0.0c) — different lifetime: durable and many, not transient and one.

---

### Protocol 1 — Context-Save (capture state to a durable checkpoint)

**Capture only — do NOT implement code changes during a save.** A save records where you are; it does not move the work forward.

**Gather git state** — run and read, don't guess:

- `git rev-parse --abbrev-ref HEAD` — the branch (goes in frontmatter, always).
- `git status --short` — the modified/untracked set.
- `git diff --stat` and `git diff --cached --stat` — unstaged and staged shape.
- `git log --oneline -10` — recent history for context.

**Infer, don't interrogate.** Fill the checkpoint from git plus the conversation you already have. Do not quiz the user for facts you can read — a save is a capture, not an interview.

**Write an APPEND-ONLY, timestamped file** to `.autodev/checkpoints/<YYYYMMDD-HHMMSS>-<title-slug>.md`:

- **title-slug** — lowercase, spaces → hyphens, strip to `a-z0-9.-`, ≤60 chars.
- **NEVER overwrite or delete an existing checkpoint.** Every save is a NEW file — the directory is a durable history, not a single slot. (This is the opposite of `PRE_COMPACT.md`, which is overwritten in place.)

**Frontmatter** — set every field:

- `status` — one-line state (e.g. *in-progress*, *blocked-on-X*, *ready-to-verify*).
- `branch` — **ALWAYS.** Critical for cross-branch restore; a checkpoint with no branch cannot be safely resumed.
- `timestamp` — ISO-8601 of the save.
- `session_duration` — if known.
- `files_modified` — the paths from `git status`.

**Four fixed sections** — in this order:

1. **Summary** — the goal and current progress in a few lines.
2. **Decisions Made** — choices, trade-offs, and the reasoning behind each (why B over A).
3. **Remaining Work** — numbered, in priority order.
4. **Notes** — gotchas, blocked items, and things you tried that did NOT work.

**Decisions Made** and **Notes** are the high-signal, anti-bloat parts a generic *"dump the diff"* omits — they are exactly what a cold reader can't reconstruct from git alone. Write them for that reader ([[00c-verifiable-threads]], §0.0c).

**The filename timestamp is the canonical clock.** It survives copy, rsync, and mtime drift — never rely on filesystem mtime to order checkpoints. After writing, confirm to the user: **title, branch, path, files, duration.**

**Ties:** Remaining Work IS the deferred set for this thread ([[00j-deferred-task-resolution]], §0.0j) — mirror it there so the turn-end sweep re-attempts it. Decisions / Notes that outlive the task belong in the durable living docs too ([[00g-swarm-living-documents]], §0.0g); the checkpoint is the resume-snapshot, not a replacement for MEMORY/LESSONS.

---

### Protocol 2 — Context-Restore (rehydrate from a checkpoint)

**Read-only — never modify code during a restore.** A restore rebuilds context; you continue the work AFTER it, not during it.

**Find and order the candidates:**

- List all `.autodev/checkpoints/*.md`.
- Sort by the **filename `YYYYMMDD-HHMMSS` prefix, DESC** — NOT filesystem mtime (mtime drifts across copy/rsync and is not authoritative; the filename clock is).
- **Reorder so current-branch checkpoints come FIRST, other-branch fallbacks after.** Do NOT hard-filter to the current branch — cross-branch fallback is what enables worktree / session handoff. But a current-branch checkpoint must NEVER be shadowed by a newer sibling-worktree save on another branch; branch-match wins over recency.

**Select:**

- If the user gave a fragment or a number, match it among the candidates.
- Else load the **newest current-branch** checkpoint — or the newest overall if none exist on this branch.

**Present** — title, branch, saved-time, duration, status, then **Summary / Remaining Work / Notes**. **Foreground WHAT'S LEFT:** restore is forward-looking — surface the remaining work, don't re-litigate the past Decisions section (it's there for reference, not for re-debate).

**Branch-mismatch warning:** if the saved `branch` ≠ the current branch, WARN before resuming — *"this checkpoint was saved on `X`, you're on `Y` — consider switching before continuing"* — rather than silently resuming stale state onto the wrong branch.

**No checkpoints found:** tell the user there are none and to run **Context-Save** first.

**Then continue the loop:** reconstruct the thread ([[00c-verifiable-threads]], §0.0c), re-attempt the deferred set ([[00j-deferred-task-resolution]], §0.0j), honor the plan ([[00e-long-horizon-planning]], §0.0e), and pick up the named next step.

---

### Before / after — the lost handoff vs the clean resume

> **Lost handoff:** you spend a session mid-refactor, then stop — nothing durable written. Next week, on a fresh session in a new worktree, you re-read the code cold, re-derive the plan, re-open a decision you'd already settled, and redo work that was finished. The thread evaporated because it lived only in a window that's gone.

> **Clean resume:** before stopping you Context-Save → `.autodev/checkpoints/20260905-1642-settings-loader-refactor.md` (branch `feat/loader`, files listed, Decisions: *split validator out; punt caching → AUT-91*, Remaining Work: *1. re-wire `index.ts` 2. fix empty-config test*, Notes: *empty-config case is RED*). Next session you Context-Restore → newest current-branch checkpoint loads, foregrounds the two remaining steps, warns nothing (branch matches), and you continue on step 1 without missing a beat.

---

**Rule of thumb:** **Save** = an append-only, branch-stamped, filename-timestamped checkpoint of *decisions + remaining work*, captured (never coded) from git + the conversation. **Restore** = newest current-branch-first, forward-looking, branch-drift-aware rehydration into the loop. Between them: never lose a thread across a session, a worktree, or a compaction.
