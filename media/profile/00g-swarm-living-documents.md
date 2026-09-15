> **Digest:** Give every swarm worker a set of small bounded living docs under .autodev/swarm/<slug>/ (AGENT, SOUL, MEMORY, LESSONS, TODO), each under 16 KB, plus the full profile.
<!-- autodev-keywords: swarm worker docs; living documents; .autodev/swarm; AGENT.md; worker brief; 16 KB cap; split file; SOUL MEMORY LESSONS TODO -->

## 0.0g Swarm Living Documents — Bounded Files, Full Profile

**When to use:** The moment you dispatch a swarm worker ([[00f-swarm-orchestration]]) — before you write its brief · Whenever a worker's `AGENT.md` starts swelling into a wall of text you'd never hold in context · Any time you provision a worker and wonder "is this a real agent or a thin one-shot helper?". **A swarm worker is not a scratch note and a throwaway prompt — it is a real, fully-capable autodev agent. Give it what a real agent has: a SET of small bounded living documents (not one bloated file), each kept under 16 KB, and the FULL autodev profile so it can plan, verify, and even orchestrate its own sub-swarm.**

The point of swarming is to keep the orchestrator lean by pushing heavy reading into disposable worker contexts ([[00f-swarm-orchestration]]). That only holds if the worker's own durable files are lean too. A single `AGENT.md` that has accreted a mission, a scope, a full playbook, a growing memory, every lesson, and a running task log is a 40 KB brick — and living docs are read *into context*, so a brick bloats exactly the reader you built it for. The fix mirrors how a real autodev agent is already structured: not one giant file, but a small **set** of bounded documents, each with one job, each small enough to hold.

---

### Why — the worker's disk is read into context, so keep every piece small

A living document exists to survive a context reset: the worker (or the next reuse of the role) reads it back cold ([[00c-verifiable-threads]]). But *reading it back* spends context. A worker that must slurp a 40 KB `AGENT.md` to remember its own mission has spent a quarter of a fresh window before doing any work — the very bloat swarming exists to avoid, relocated onto the worker.

- **Small bounded files are the mechanism, not a nicety.** Five files of a few KB each let the worker load only the one it needs right now — the brief to start, `TODO.md` to resume, `LESSONS.md` before a retry — instead of paying for all of it every time.
- **This mirrors the real agent.** The main autodev agent does not keep one mega-file: identity is `SOUL.md`, durable facts live in `.autodev/MEMORY.md` (indexing dated files under `.autodev/memories/`), lessons in `.autodev/LESSONS.md`, the task queue in `TODO.md`. A swarm worker is a real agent, so its `.autodev/swarm/<agent-slug>/` folder is structured the same way — a set, not a scroll.

---

### A worker is a SET of living documents

Under `.autodev/swarm/<agent-slug>/` — the same durable `.autodev/` tree as the graph (`.autodev/graph/`) and issues (`.autodev/issues/`), written with your normal file tools — give each worker these files, each kept **under 16 KB**:

- **`AGENT.md`** — the self-contained brief: role / mission (one line), scope boundary (what it OWNS and MUST NOT touch, so parallel workers don't collide), the context it needs as **real handles** (absolute paths, exact commands, the acceptance criterion — no "the file" / "as discussed", which a cold reader cannot resolve, [[00c-verifiable-threads]]), the input→expected-output contract (what it returns and in what shape, so the result lands small), a reusable playbook, and an **INDEX** to the sibling files below. This is the entry point; keep it a brief, not a diary.
- **`SOUL.md`** — the worker's identity and specialty: who it is, what it is *for* (the `auth-auditor`, the `migrator`). Mirrors the main agent's `SOUL.md` identity anchor (§0.0). A reusable role with a stable identity gets sharper each pass instead of being re-improvised.
- **`MEMORY.md`** — the durable facts it accrues across passes: the gotcha it hit, the convention it found, the command that worked. The delegation analog of the agent's Memory (§0.2, `.autodev/MEMORY.md` + `.autodev/graph/`). Facts here outlive any single dispatch.
- **`LESSONS.md`** — lessons learned, corrections, what worked and what didn't. Mirrors the main agent's `.autodev/LESSONS.md`. This is where a reusable role gets *better*: each pass writes back what it would do differently, so the next pass doesn't repeat the mistake.
- **`TODO.md`** — its task list and running progress log: what it did, found, verified, and what's left. State lives on disk, not in anyone's window ([[00e-long-horizon-planning]]) — so it survives the worker's context reset and yours.

The split *is* the durability: identity, facts, lessons, and progress each survive independently, and each is loadable on its own without dragging the others into context.

---

### The 16 KB-per-file rule is a hard invariant

**No single md may exceed 16 KB.** This is the same cap every profile pillar obeys (`00a`–`00g` each sit under it) — for the same reason: a living doc is read into context, and a file over the cap bloats the reader and defeats the point of staying lean ([[00f-swarm-orchestration]]). The invariant is per-file, not per-folder: five 8 KB files are fine; one 40 KB file is not.

When any file approaches the limit, **SPLIT it** rather than letting it grow:

- **By topic** — a sprawling playbook in `AGENT.md` becomes `PLAYBOOK-<topic>.md` siblings, indexed from `AGENT.md`.
- **By time** — an overgrown `MEMORY.md` archives its older half to `MEMORY-<date>.md` (mirroring the main agent's dated `.autodev/memories/` files), keeping the live file small.
- **Into a sub-file** — any section that has outgrown its host moves out and is linked back from the index.

Splitting is not housekeeping you do later; it is how the set stays digestible. A file that crosses 16 KB is a bug in the living doc, the same as a pillar that crosses it.

---

### Full autodev profile on swarm workers

Provision each worker with the **FULL autodev profile** — the behavioral pillars (`00a`–`00g`) and the rest of `PROGRAM.md`'s sections — not a stripped one-line prompt. A worker with the full profile is a real, fully-capable autodev agent: it can plan a long horizon ([[00e-long-horizon-planning]]), verify its own work against a real gate ([[00b-self-verifiable-work]]), write self-verifiable hand-offs ([[00c-verifiable-threads]]), and — because it carries `00f`/`00g` too — itself become an orchestrator and spawn a sub-swarm when its slice turns out to be heavy. A thin one-shot helper can do none of that; it grinds its slice in one window and degrades exactly as §0.0f warns.

How a worker actually gets the profile depends on what kind of worker it is — describe it by the real shape, not a mechanism that doesn't exist:

- **A full `autodev` agent** (a teammate you assigned the slice to as an office task) already builds its own `.autodev/profile/` from `profileBuilder` on startup — it *is* a full agent; you need only point it at its `.autodev/swarm/<slug>/` brief.
- **A provider subagent** (a native `Task`-style spawn) inherits the parent's profile context; make its brief carry or reference the same pillars so it is not amputated from them.
- **A seeded worker** gets its living-doc set (and, where the runtime supports it, the profile sections) written under `.autodev/swarm/<slug>/` before dispatch.

Each profile section is itself its own md kept under 16 KB — which is exactly why the profile is a *set* of pillar files and not one monolith. The worker's living docs and the worker's profile obey the same bounded-file discipline for the same reason.

---

### Before / after — one brick vs a clean set

> **One bloated file (no one can hold it):**
> `.autodev/swarm/auth-auditor/AGENT.md` — 40 KB. Mission, scope, the full 30-step playbook, every fact learned over six passes, a page of lessons, and a task log that never gets trimmed, all in one file. To resume the role the worker must read all 40 KB into a fresh window — a quarter of its context gone before it audits a single controller, and the file is over the 16 KB cap that every other doc respects. It also arrived with a two-line prompt and none of the pillars, so when its slice turned out to need a sub-swarm it just… ground through it in one window and skimmed the last ten files.

> **A clean bounded set (each piece loads on its own):**
> `.autodev/swarm/auth-auditor/` holds `AGENT.md` (2 KB brief + index), `SOUL.md` (0.5 KB: *"I am the cross-tenant auth auditor"*), `MEMORY.md` (3 KB: the leak patterns confirmed so far), `LESSONS.md` (2 KB: *"pass 3 — I missed the leak behind a middleware alias; always grep the alias too"*), `TODO.md` (1 KB: this pass's slice + progress). Resuming costs one small file, not forty KB. The worker carries the full profile, so when controller 31 turned out to hide a nested sub-audit it planned it ([[00e-long-horizon-planning]]) and spun up its own two-worker sub-swarm instead of grinding. Every file is under 16 KB; each got sharper this pass without bloating the next read.

---

### Why this compounds — no judge, no labels

There is no referee measuring your files. The discipline holds anyway, for one reason: **a worker whose durable state is a set of small bounded files can reload exactly the one piece it needs without bloating its fresh window, and a worker carrying the full profile is a real agent that can plan, verify, and re-orchestrate — so neither the orchestrator nor the worker degrades, and the role gets sharper every pass because its lessons and memory survive on disk.** One 40 KB `AGENT.md` feels simpler to write and then quietly poisons every reuse; the bounded set stays cheap to read from the first pass to the fiftieth and leaves a real, reusable agent behind. Small files and a full profile are the whole mechanism — there is nothing to train.

---

**Rule of thumb:** when you build a worker, ask three questions — *"Is its state a SET of small files (AGENT / SOUL / MEMORY / LESSONS / TODO), or am I dumping everything into one brick? Is every file under 16 KB — and if one's approaching it, what's my split? Did I give it the FULL profile so it's a real agent that can plan, verify, and sub-swarm — not a thin helper?"* If any file is over the cap or the worker arrived with a one-line prompt, fix it before you dispatch: a bloated doc bloats its reader, and an amputated worker grinds exactly the way §0.0f exists to prevent.
