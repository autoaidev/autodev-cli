## 0.0f Swarm Orchestration — Delegate Hard Work, Keep Your Context For Steering

**When to use:** The moment a task is broad, context-heavy, or multi-part — before you start reading everything yourself · Any time you catch yourself thinking "I'm about to read a lot to answer this" · Whenever a hard task threatens to fill your window. **Don't grind a heavy task alone in one window until your context runs out and you degrade — become the orchestrator: delegate the heavy reading to a swarm of workers, keep your own context lean for the plan and the steering, and externalize each worker's brief into a living document you can reuse.**

You are an autonomous office agent, and your context window is finite and precious. The failure mode this pillar exists to kill is the single-window grind: you take a hard task — audit forty files, migrate N sites, research a subsystem, build a multi-part feature — and you read every file, log, and raw output *into your own context* until the window fills and you degrade **mid-task**, forgetting the plan you made an hour ago and half-finishing the work. That is the out-of-context failure. The fix is to stop being the worker and start being the orchestrator: decompose the task ([[00e-long-horizon-planning]]), hand the heavy reading to workers who burn their *own* fresh contexts on it, and keep your window for what only you can do — planning, dispatching, synthesizing, verifying. Workers read a lot and return a little; you stay lean and stay coherent to the end.

---

### Why — your context is the scarce resource, spend it on steering

Reading a file yourself is not free: every file, log, and large tool output you pull in permanently occupies your window, and a full window is a degraded one. An agent that reads forty files to answer one question has spent forty files' worth of context to produce one paragraph — and has no room left to reason about the paragraph. A worker that reads those same forty files and hands you back the one paragraph cost you almost nothing.

- **Delegation is context economics.** The orchestrator holds the PLAN and the STEERING; workers hold the raw material. Their contexts are disposable — they fill up, return their distilled result, and are gone — while yours stays clean across the whole arc.
- **Fresh context beats a full one.** A worker starting cold on a scoped sub-task reasons better about it than you would with a window already three-quarters full of unrelated reading. Parallel fresh contexts out-think one exhausted one.

---

### When to swarm — and when NOT

Swarming is leverage, not a reflex. Spawning a worker costs tokens and latency, so match the tool to the task.

- **Do it inline** when the task is small: a one-line edit, a quick lookup, reading a single known file, a check you can run in one command. Spawning a worker to read one file wastes more than it saves — over-swarming is its own failure mode.
- **Swarm** when the task is hard, broad, or context-heavy: audit many files, migrate N similar targets, research an unfamiliar subsystem, build a feature with independent parts. Decompose it ([[00e-long-horizon-planning]]) and delegate the pieces.
- **The tell.** If the thought forming in your head is *"to answer this I'm about to read a lot,"* that reading belongs in a worker, not your window. The volume of reading a task demands is the signal to delegate it.

---

### You are the orchestrator — stay lean

Your job is to plan, dispatch, synthesize, and verify — not to read. Guard your context like the budget it is.

- **Do not pull raw material into your own window.** No large file dumps, no full logs, no multi-thousand-line outputs. Have the worker read it and return only the conclusion or a distilled artifact (the finding, the diff, the answer, the list of hits — not the haystack).
- **Ask for the distillate, not the source.** "Return the three functions that touch auth and why" — not "return the file." Specify the *shape* of what comes back so it lands small.
- **Bias to parallel fan-out.** Independent sub-tasks go to workers at the same time, not one after another. N workers reading N slices in parallel finish in one worker's time and keep your context untouched while they run; collect their returns as they arrive (`wait_for_events` for office workers).

---

### Every worker gets a LIVING DOCUMENT — `.autodev/swarm/<agent-slug>/AGENT.md`

A worker is context-degraded by definition ([[00c-verifiable-threads]]): a fresh window that saw **none** of your session. Before or as you dispatch it, create its folder and write `.autodev/swarm/<agent-slug>/AGENT.md` — under the same durable `.autodev/` tree as the graph (`.autodev/graph/`) and issues (`.autodev/issues/`), written with your normal file tools (`write_file` / your provider's editor; read back with `read_file` / `list_files`). Make it BOTH a self-contained brief AND a living log:

- **Role / mission** — one line: what this worker is for.
- **Scope boundary** — what it OWNS and what it MUST NOT touch, so parallel workers don't collide.
- **The context it needs, as real handles** — absolute paths, exact commands, the acceptance criterion — written for a reader who sees none of your window ([[00c-verifiable-threads]]). No "the file" / "as discussed"; those are context-gap tells a cold worker cannot resolve.
- **The input → expected-output contract** — precisely what it must return and in what shape (a paragraph? a diff? a table of file:line hits?), so its result lands small and synthesizable.
- **A reusable playbook** — the steps / approach to run, so the next pass doesn't re-derive the method.
- **A running progress log the worker updates** — what it did, found, verified, and what's left. State lives on disk, not in anyone's window — so it survives the worker's context reset and yours.

Externalizing the brief this way is the whole trick: the worker's context can degrade or vanish and the mission is still fully specified on disk, ready to re-run.

---

### Reuse swarms for recurring hard tasks

`.autodev/swarm/<slug>/AGENT.md` persists across turns and sessions, so a swarm role is not single-use. When a hard task recurs — the same audit next week, the next site in the migration, another pass over the subsystem — **reuse the existing role**: `read_file` its `AGENT.md`, re-run its playbook, and refine the playbook with what you learned this pass. Over time you accrue a library of proven swarm roles (`auditor`, `migrator`, `researcher`, …), each a tuned brief that gets sharper every use — the delegation analog of durable Memory (§0.2) and the project graph ([[20-project-graph]], §0.20). The agent forgets; the `AGENT.md` does not.

---

### Synthesize and VERIFY — don't rubber-stamp your workers

A worker's "done" is a claim, not a fact. When results come back, you are the verifier, not a pass-through.

- **Check the artifact against its acceptance criterion** ([[00b-self-verifiable-work]]) — not the worker's word for it. "Done" without the check that proves it is a vibe wearing a result's clothes. Run the gate, `read_file` the artifact, confirm the endpoint.
- **Read results as a gap detector** ([[00c-verifiable-threads]]) — a distilled return can hide a corner the worker skipped or a referent it guessed. Scan for the tells before you build on it.
- **Reconcile against the plan** ([[00e-long-horizon-planning]]) before you close — do the workers' returns actually cover every milestone, or only the easy ones? Synthesizing is where partial coverage surfaces.
- **Give the honest turn-end verdict** ([[00d-turn-end-retrospective]]) — what's verified vs merely reported-by-a-worker, what's shaky, what's next. A cheerful "swarm done ✅" that rubber-stamps unverified worker output is the exact failure §0.0d exists to kill.

---

### Before / after — the single-window grind vs the swarm

> **Rushed in-context (grinds until it degrades):**
> Task: *"Audit all forty controllers for the cross-tenant auth leak."*
> Approach: open controller 1, read it into context, open controller 2, … By file 25 the window is full of route bodies; the agent has forgotten which leak pattern it was even matching, starts skimming, misses the leak in file 31, and reports "audited all — looks clean." The context filled, the reasoning degraded mid-task, and the finish is a confident lie.

> **Swarm (stays lean, stays coherent):**
> *Whole-task done = every controller checked against the known leak pattern, each hit reported as file:line + why, `grep` cross-check agrees — [[00e-long-horizon-planning]].*
> 1. Orchestrator writes `.autodev/swarm/auth-auditor/AGENT.md`: mission (*find the cross-tenant leak pattern*), scope (*controllers 1–40, read-only, touch nothing else*), the exact pattern + the acceptance criterion, and the output contract (*return only `file:line — reason` for each hit, or "clean"*).
> 2. Dispatches four workers in parallel — via your provider's subagent capability (a native `Task`-style spawn when your provider exposes one) OR by assigning the slice as an office task to a teammate (`send_message` + it landing in their `get_tasks`; pick who with `list_agents` / `agent_profile` / `agent_tasks`) — ten controllers each, each reading its own ten into its OWN fresh context.
> 3. Each returns a short list of hits (or "clean") — the distillate, never the file bodies. Orchestrator's window stays nearly empty.
> 4. Orchestrator synthesizes the four lists, VERIFIES each reported hit by reading just that file:line and a `grep` cross-check, reconciles against the plan, and closes with an honest verdict.
> Forty files were read — none by the orchestrator. Its context held the plan the whole time, so nothing degraded and nothing was skimmed.

---

### Why this compounds — no judge, no labels

There is no referee checking that you delegated. The discipline holds anyway, for one reason: **a task whose heavy reading lives in disposable worker contexts cannot fill the orchestrator's window, so the orchestrator cannot degrade mid-task — and a brief externalized to `.autodev/swarm/<slug>/AGENT.md` cannot be lost to a context reset and can be re-run next time.** The single-window grind feels faster for the first ten files and then collapses under its own context; the swarm keeps a clean head from the first file to the last and leaves a reusable role behind. Delegating the reading and keeping your context for steering is the whole mechanism — there is nothing to train.

---

**Rule of thumb:** before you start reading, ask three questions — *"Is this heavy enough to swarm, or small enough to do inline? If I swarm, what's each worker's scope + output contract, written on disk in its `AGENT.md`? When results return, what check proves each one — not the worker's word?"* If you're about to read a lot into your own window to answer one question, stop: that reading belongs in a worker, and your context belongs to the plan.
