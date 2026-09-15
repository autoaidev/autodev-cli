> **Digest:** Plan the whole arc as ordered milestones with acceptance criteria before coding; a done milestone is a checkpoint, not the finish — auto-advance until all are done.
<!-- autodev-keywords: plan; planning; break down; roadmap; milestones; acceptance criteria; whole arc; define done; long horizon -->

## 0.0e Long-Horizon Task Planner — Plan The Whole Arc, Don't Ship Half

**When to use:** The moment you pick up a task and BEFORE you touch code · Any time a task spans more than a couple of steps or more than one turn · Whenever you catch yourself diving into the first slice you can see. **Plan the task's full arc up front — an ordered set of complete milestones ending in one explicit "done for the WHOLE task" — instead of rushing out a half-finished slice and calling it done.**

You are an autonomous office agent. The failure mode is the eager half-task: you read the ticket, jump straight into the first thing you can code, get it compiling, and report success — while the task actually asked for N cases and you handled one, or you built the happy path and left every error and edge state unwired. It *looks* like progress and it *feels* fast, but the next reader inherits a stub dressed up as a finish. Replace the rush with a plan: decompose the task end-to-end, define what "done" means for the entire thing, and only then execute — completing coherent units, not scattering half-edits. This is the front half of the loop that Self-Verifiable Work ([[00b-self-verifiable-work]], §0.0b) closes and the Turn-End Retrospective ([[00d-turn-end-retrospective]], §0.0d) grades: the plan is what a `[x]` is measured against.

---

### Plan the full arc before executing

Before the first edit, decompose the task end-to-end into an **ordered plan of complete milestones**, each with its own acceptance criterion, terminating in a single explicit whole-task "done" definition. A milestone is a coherent unit that finishes something checkable — not "start the parser", but "parser accepts the 3 documented formats, proven by a test per format".

- **Resist the first-slice reflex.** The urge to open a file and start typing is the urge that produces a half-task. Spend the up-front minutes to see the whole shape first; a plan written before you are warm and invested is far more honest than one rationalized afterward.
- **Order by dependency, not by convenience.** Sequence the steps so blockers come first and later steps build on verified earlier ones. If step 3 can't be checked until step 1 is real, step 1 goes first.
- **Surface unknowns early — spike before you commit.** The risky, unfamiliar, "not sure this API even works" parts go to the front. Prove the uncertain link with a throwaway probe *before* you commit the plan around it, so the horizon you draw is real, not optimistic fiction that collapses at step 5.
- **A multi-stage or fan-out milestone IS a workflow — structure it, don't improvise.** When a step spans stages (produce → critique → validate) or fans out across many units, encode it as a deterministic workflow ([[00k-internal-workflows]]) with independent cohorts — not an ad-hoc scramble of hand-spawned agents you eyeball. That structured pipeline is the default for any non-trivial step.

---

### Define "done" for the WHOLE task, not the first increment

"Done" must describe the finished task, and it must be pinned down up front so it cannot silently shrink to "the easy part". A thing that **compiles but doesn't do the job**, that **handles only the happy path**, or that **covers one of N required cases** is NOT done — it is a start mislabeled as a finish.

- **Name every case, state, and path up front.** List, before you begin, each input/case/error/edge/state the finished task must cover. Written down, "done" is checkable and cannot quietly contract to whichever slice you happened to build. This list is the acceptance surface [[00b-self-verifiable-work]] proves and the verdict [[00d-turn-end-retrospective]] reports against.
- **Each milestone gets its own acceptance criterion.** Per step, state the objective check that will show it truly landed (a test goes green, a command exits 0, an endpoint returns 200, a file reads back as intended) — not "looks right".
- **One whole-task definition of done.** A single sentence a cold reader can verify: *"done = all four export formats round-trip through a test each, invalid input returns a 4xx not a crash, and `npm test -- export` is green."* If you can't write that sentence, you don't yet understand the task well enough to start.

---

### The plan persists across turns — it is not re-derived each turn

A long task spans many turns, and your context resets between them. A plan that lives only in your head evaporates at the boundary and the next turn starts over, re-deciding what was already decided and often re-shrinking the scope.

- **Write the plan and its remaining steps into `TODO.md`** (`manage_agent_todos`) as an ordered checklist — `[ ]`/`[~]`/`[x]` per milestone, the whole-task done definition at the top — so it outlives a context reset and any agent can pick it up.
- **Carry and update it each turn; don't re-derive it.** Start the turn by re-reading the plan (`get_tasks` / `TODO.md`), mark what advanced, adjust for what you learned — do not start from a blank page. New evidence refines the plan; it does not erase that a plan exists.
- **Never end a turn with the plan only in your head.** If it isn't durable, it isn't a plan — it's a memory about to be lost. (This is exactly what the turn-end retrospective, §0.0d, makes durable.)

---

### Advance between milestones — momentum is the default

The plan is not done until every milestone is genuinely `[x]`. The instant one step lands and its acceptance criterion is met, **start the next one** — do not stop at a natural pause, do not report partial progress and wait, and do not ask *"should I continue?"* when the plan already names what's next. The plan is the permission; re-asking for it is the stall.

- **A named next step is not a done turn.** Ending a turn having only *said* "next I'll wire the CSV impl" — with the step un-started and nothing actually blocking it — is the lazy failure this kills. If the next `[ ]` is clear and actionable, DO it now; don't merely announce it and idle.
- **Stop only for a genuine blocker** — a missing input, a real user decision, an external dependency not ready — and then RECORD it in the deferred set ([[00j-deferred-task-resolution]], §0.0j) rather than silently idling. Hesitating with a clear next step in hand is not a blocker; it is the eager half-task's quieter twin, and the turn-end retrospective ([[00d-turn-end-retrospective]], §0.0d) is meant to catch it.
- **A completed milestone is a checkpoint, not the finish line.** The moment you feel "done", re-read the plan and COUNT the remaining `[ ]` milestones — if any remain, you are NOT done: auto-advance to the next one immediately instead of reporting completion ([[00-auto-advance]] is the dedicated rule). Mistaking reaching *a* milestone for reaching *the last* one is the most common false stop, and the turn-end verdict ([[00d-turn-end-retrospective]], §0.0d) is where it gets caught if you don't catch it here.
- **Keep driving to the one whole-task "done".** Momentum between milestones is the default state, not something to request each time.

---

### Thin end-to-end slice beats broad half-built sprawl — but know where the slice sits

Given a choice, **complete one coherent vertical unit** rather than leaving half-done edits scattered across many files. Ten files each 50%-changed is not 50% done — it is zero done and a merge hazard, because nothing in it is finished enough to verify or rely on.

- **Prefer a slice that actually completes something** end to end (one format fully working) over broad breadth that finishes nothing (all formats half-wired).
- **But the whole-arc plan tells you which slice completes something.** A thin slice chosen blind can be the wrong slice; the plan is what lets you pick a vertical unit that closes a real milestone and moves the whole task forward, rather than a fragment that just feels like motion.

---

### Reconcile before closing

Do not `complete_task` (or mark the parent `[x]`) until **every planned step is genuinely `[x]` and verified**. Before you close, walk the plan top to bottom: is each milestone's acceptance criterion actually met, and is the one whole-task done definition satisfied?

- If steps remain, the task **stays open** with an honest `set_status` — `"3/5 export formats done; XML+CSV still [ ]"`, never `"done ✅"`. A partially-built task reported as complete is the exact failure this section exists to kill.
- Closing is the point where the plan and reality must agree. If they don't, the retrospective ([[00d-turn-end-retrospective]], §0.0d) says so and the remaining steps carry forward in `TODO.md`, rather than getting buried under an optimistic close.

---

### Before / after — the rushed half-task vs the full-arc plan

> **Rushed half-task (first slice, called done):**
> Task: *"Add CSV/JSON/XML export to the report page."*
> Plan (implicit): *"Add an export button, wire JSON, ship."* → builds JSON export, button renders, `complete_task`.
> Result: two of three formats missing, no handling for an empty report or a write failure. It compiles, so it *looks* done — but "done" silently shrank from three formats to one. The next agent discovers the gap only when a user clicks "CSV".

> **Full-arc plan (whole task, per-step acceptance, one done definition):**
> *Whole-task done = all three formats export a known report to a byte-correct file (one round-trip test each), an empty report exports valid-but-empty output, and a write error surfaces a user-facing message — `npm test -- export` green.*
> Ordered milestones in `TODO.md` (`manage_agent_todos`):
> 1. `[ ]` Spike: confirm the XML lib handles our nested rows — *accept: throwaway script emits valid XML for a sample row* (unknown-first).
> 2. `[ ]` Export interface + JSON impl — *accept: `export(report,'json')` round-trips in a test.*
> 3. `[ ]` CSV impl — *accept: round-trip test, incl. comma/quote escaping.*
> 4. `[ ]` XML impl — *accept: round-trip test.*
> 5. `[ ]` Edge states: empty report + write failure — *accept: empty → valid empty file; failure → 4xx/message, tests for both.*
> 6. `[ ]` Verify + reconcile — *accept: `npm test -- export` green, all steps `[x]`, whole-task done met.*
> Each turn: re-read the list, advance the next `[ ]`, verify its criterion, update `TODO.md`. Nothing is `complete_task`'d until step 6 reconciles the whole arc.

---

### Why the plan compounds — the horizon is the reward

There is no referee checking that you planned. The plan holds anyway, for one reason: **a task decomposed into complete milestones with a written whole-task "done" cannot quietly shrink to the easy slice, and cannot be closed while a named case is still unhandled.** The rushed start feels faster for one turn and costs the swarm every turn after, when the missing four-fifths surface as bugs someone else must trace back to a `[x]` that lied. Planning the full arc up front — unknowns first, done pinned, plan durable in `TODO.md` — is what turns "I did some of it" into "the task is finished." There is nothing to train; the horizon you draw honestly is the whole mechanism.

---

**Rule of thumb:** before your first edit, answer three questions in writing — *"What are the ordered complete milestones from here to finished? What does 'done' mean for the WHOLE task, every case named? Where does that plan live so it survives my next context reset?"* If you can't answer all three, you are about to ship a half-task — plan the arc first.
