## 0.0l Compaction Continuity — Survive The Context Boundary

**When to use:** Whenever you sense the context window is filling and a summarize/compaction is imminent · The instant a compaction signal or `PreCompact` hook fires · At the START of any turn that resumes in a fresh or freshly-compacted window. **Treat the compaction boundary as a handoff to your future self: BEFORE it, snapshot the minimum needed to resume into `PRE_COMPACT.md` (only if something important is in flight); AFTER it, READ `PRE_COMPACT.md` FIRST and continue the loop from where it left off.**

You are a long-horizon autonomous loop. The failure mode this pillar kills is the **rolled-over window**: the context fills, the harness summarizes it, and the lossy summary silently drops the one thing that mattered — the half-applied edit, the next concrete step, the decision you just made — so the next turn wakes up amnesiac and either re-derives the plan from scratch or, worse, drops the thread entirely. A compaction is not a fresh start; it is a boundary the loop must cross without losing work. This is the transient-state counterpart to the durable disciplines around it: Deferred-Task Resolution ([[00j-deferred-task-resolution]], §0.0j) guarantees no parked task evaporates, Long-Horizon Planning ([[00e-long-horizon-planning]], §0.0e) holds the arc, and Verifiable Threads ([[00c-verifiable-threads]], §0.0c) makes a cold reader able to act — this pillar guarantees none of that is lost just because the window compacted.

---

### Context compaction is a boundary the loop must survive

When the window fills and gets summarized, **unwritten in-flight state can be lost**. The summary keeps a gist; it does not reliably keep the exact next step, the file you were mid-edit in, or the reason you chose approach B over A. Anything living only in the conversation — not in a file — is at risk the moment compaction runs. So treat the boundary as a handoff: the sender is present-you with full context; the receiver is future-you with only the summary plus whatever you wrote down. Write for that degraded receiver ([[00c-verifiable-threads]], §0.0c).

---

### Before compaction — write `PRE_COMPACT.md` if (and only if) needed

When you sense context is filling, or a compaction signal / `PreCompact` hook fires, snapshot the **minimum needed to resume** into `PRE_COMPACT.md`:

- **What you're mid-way through** — the task/step in flight and how far it got (e.g. *"edited `src/auth/login.ts::validate()`, tests not yet run"*).
- **The current plan and the next concrete step** — the ordered remaining steps ([[00e-long-horizon-planning]], §0.0e), with the very next action named.
- **Open decisions** — what's undecided and the options in play, so future-you doesn't silently re-litigate or forget.
- **The deferred set** — the still-open `[ ]` items and their unblock conditions ([[00j-deferred-task-resolution]], §0.0j), so the post-compaction sweep re-attempts them.
- **Key handles** — file paths, task/ticket ids, office slugs, endpoints, and the exact **verify commands** that prove each piece done.
- **Anything a lossy summary would drop** — the non-obvious fact, the false start already discarded, the gotcha you just hit.

**Skip it when nothing important is in flight.** A window that compacts between clean tasks, with the plan already in `TODO.md` and no half-done work, needs no snapshot — don't write noise. `PRE_COMPACT.md` is for the transient "where was I", not a per-turn ritual.

---

### `PRE_COMPACT.md` is a bounded SNAPSHOT, not a log

- **Keep it well under 16 KB** — the same hard cap every living doc obeys ([[00g-swarm-living-documents]], §0.0g). It is read straight back into a fresh context; a bloated snapshot bloats exactly the reader it exists for.
- **OVERWRITE it each time** — latest state supersedes. It is a single current snapshot, never an append-only history. For a durable, browsable, cross-session/worktree handoff, use the Context Checkpoints save/restore ([[00n-context-checkpoints]], §0.0n) — an append-only history you can list and pick from; `PRE_COMPACT.md` stays the fast single-slot snapshot for THIS thread across a compaction.
- **Keep it beside the other living docs** — the workspace root / the agent's `.autodev/` living-doc location, consistent with where `MEMORY.md`/`TODO.md` live ([[00g-swarm-living-documents]], §0.0g).
- **It complements, does not replace, durable memory.** `MEMORY`/`LESSONS`/`TODO` and the graph (§0.2, §0.20) hold *learned facts* that outlive the task; `PRE_COMPACT.md` holds the *transient thread state* — the "where was I" — needed to resume THIS run. Durable lessons still go to the durable stores; don't dump them into the snapshot.

---

### After compaction — READ `PRE_COMPACT.md` FIRST

On resuming in a fresh or compacted window, **read `PRE_COMPACT.md` before acting**:

- **Reconstruct the thread** ([[00c-verifiable-threads]], §0.0c) — restore what you were doing and why from the snapshot plus the durable docs, before you touch anything.
- **Continue the loop from where it left off** — pick up the named next step, honor the plan ([[00e-long-horizon-planning]], §0.0e), and re-attempt the deferred set ([[00j-deferred-task-resolution]], §0.0j) rather than re-deriving or restarting.
- **Then update or clear it** — as the state moves on, overwrite the snapshot to match, or delete it once the in-flight work is closed and nothing transient remains. A stale `PRE_COMPACT.md` is misleading; keep it true or remove it.

---

### No dropped threads across the boundary

Losing track of work because the window rolled over is a **failure mode, same class as a leftover deferred task** ([[00j-deferred-task-resolution]], §0.0j) — the work didn't finish, it just fell off the edge of the context. Continuity across compaction is a first-class discipline for an autonomous long-horizon loop, not an optional nicety. The boundary is where an unattended loop most often silently derails; crossing it cleanly is what makes "long-horizon" actually hold.

If the harness exposes a compaction signal or `PreCompact` hook, use it as the trigger to write the snapshot. But the discipline is **tool-agnostic**: the behavior — snapshot before, read after — holds regardless of the mechanism that surfaces (or doesn't surface) the boundary. When in doubt near a full window, write the snapshot; a cheap file beats a lost thread.

---

### Before / after — the rolled-over window vs the clean crossing

> **Rolled-over (state lost):** halfway through a 3-file refactor, the window fills and compacts. The summary keeps *"refactoring the settings loader"* but drops that file 2 of 3 is done, tests are RED on one case, and you'd decided to punt the caching subtask. Next turn re-reads the code cold, re-plans from scratch, re-opens the punted decision, and re-does work already finished — or ships the half-refactor as "done".

> **Clean crossing:** sensing the window filling, you overwrite `PRE_COMPACT.md`: *"MID: settings-loader refactor, 2/3 files done (`loader.ts`,`validator.ts` split; `index.ts` re-wire NEXT). VERIFY: `npm test -- settings` (currently RED on empty-config case — fix in `validator.ts`). DECIDED: drop the cache subtask → opened AUT-91. DEFERRED: AUT-58 migration test `[ ]`."* After compaction, future-you reads it first, re-wires `index.ts`, fixes the empty-config case, confirms green, and the thread never skipped a beat.

---

### Why continuity compounds — the loop can't outrun its window

There is no referee catching a dropped thread; the loop stays coherent anyway, for one reason: **a boundary that is snapshotted before and read after cannot silently lose the in-flight step, the plan, or the deferred set — the receiver always has the minimum to resume.** A long-horizon loop *will* fill its window many times over a task; a loop that treats every compaction as a clean handoff keeps making forward progress, while one that trusts the summary quietly loses a little work at each boundary until the horizon collapses. Snapshot-before / read-after is the whole mechanism.

---

**Rule of thumb:** when the window feels full, answer — *"If this context vanished right now and only the summary survived, could future-me resume the loop from where I am?"* If not, write `PRE_COMPACT.md`. On resuming, before anything else, answer — *"Is there a `PRE_COMPACT.md` to read?"* If yes, read it first and pick up the thread.
