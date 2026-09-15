> **Digest:** Structure any multi-stage or fan-out work as a deterministic workflow (produce → validate → critique → synthesize) run by independent cohorts, not ad-hoc spawns.
<!-- autodev-keywords: workflow; multi-stage; fan-out; produce validate critique synthesize; deterministic; template; independent cohorts; not ad-hoc spawns -->

## 0.0k Internal Workflows — Deterministic Pipelines, Not Ad-Hoc Spawns

**When to use:** The moment work has STAGES (produce → validate → critique → synthesize) or needs BREADTH (many files/dimensions in parallel) — before you spawn the first worker · Any time you catch yourself about to fire several agents in sequence by hand and eyeball what comes back · Whenever "I'll just spin up a few agents and see" is the plan. **Don't orchestrate a swarm as a loose bag of one-off spawns you improvise and read by eye. Structure it as a DETERMINISTIC internal workflow: explicit fan-out, barriers only where a stage truly needs all prior results, loop-until-clean — with validation and critique run by SEPARATE cohorts independent of the producer. Reach for a workflow whenever you'd otherwise hand-spawn agents in sequence; ad-hoc spawning is the exception, the workflow is the norm.**

You are an autonomous office agent orchestrating a swarm ([[00f-swarm-orchestration]]). Swarming tells you *to* delegate; this pillar tells you *how to shape* the delegation. The failure mode it kills is the ad-hoc spawn: you throw three agents at a task, read their returns by eye, decide it "looks done," and move on — no defined stages, no barrier where results must converge, no independent check, no reproducibility. Re-run it tomorrow and you get a different shape and a different answer, because the process lived in your head, not on disk. The fix is to treat orchestration like a program: a workflow with named stages, explicit fan-out, defined join points, and a loop that repeats until an objective gate is clean. Determinism, reproducibility, and coverage are the whole point — a workflow you can re-run and that covers every dimension beats a clever one-off you can't reproduce. When a stage completes, advance to the next task rather than stalling ([[00-auto-advance]]).

---

### Prefer a workflow — the default for anything multi-stage or fan-out

If the thought forming is *"I'll spawn a few agents in sequence and check as I go,"* stop: that sequence IS a workflow — encode it as one instead of improvising it. A workflow is a deterministic multi-stage orchestration you can name, re-run, and reason about; an ad-hoc spawn is a guess you run once.

- **Stages, not vibes.** Decompose the task ([[00e-long-horizon-planning]]) into explicit stages — typically **produce → validate → critique → synthesize** — each with an input→output contract and an acceptance gate. The stages are the workflow; write them down before dispatching.
- **Fan-out for breadth, deterministically.** When a stage covers many independent units (N files, N dimensions, N targets), fan out one worker per unit in parallel — a defined set, not "a few." Coverage is a property you can check (every unit has a return), not a hope.
- **Barriers only where a stage genuinely needs all prior results.** A join/barrier costs latency, so place one only where the next stage truly requires every fan-out result (e.g. synthesize needs all findings). Independent stages run without waiting; don't serialize what can parallelize, don't parallelize what must converge.
- **Loop until clean.** The workflow doesn't end at "produced" — it loops **produce → verify → critique → (defects? → revise) → re-verify** until an objective gate passes, exactly the critique-until-clean loop of [[00b-self-verifiable-work]] made into a pipeline.
- **Ad-hoc is the exception.** A single small edit or one lookup does not need a workflow — do it inline ([[00f-swarm-orchestration]]). But anything multi-step, multi-file, or multi-stage is workflow-shaped by default.

---

### Validation and critique are SEPARATE swarms — independence is the signal

A workflow's trust comes from *who checks whom*. The cohort that PRODUCES, the cohort that CRITIQUES, and the cohort that VALIDATES must be **distinct and independent** — no stage grades its own output. This is the same independence that makes any check trustworthy ([[00b-self-verifiable-work]], self-verifiable work), lifted to the swarm.

- **Producer → separate critic swarm → separate validation/QA swarm**, each a distinct cohort with its own fresh context. The producer builds; a critic cohort that never wrote the code reads it to REFUTE ([[00f-swarm-orchestration]], the critic swarm); a validation/QA cohort that neither wrote nor reviewed it RUNS the real thing ([[00i-qa-swarm]]). Three roles, three independent contexts.
- **No self-grading.** A producer's own "done ✅" and a producer's own green tests are biased by construction — they pass on exactly the path the producer designed. The signal only becomes trustworthy when an agent with no stake in that "done" checks it. If the same cohort produces and validates, you have one opinion wearing two hats, not verification.
- **The workflow encodes the independence.** Because the stages and their cohorts are defined up front, "who verifies this, independently?" is answered by the pipeline's shape — not left to whether you happen to remember to double-check.

---

### Adversarial verification — critique to refute, keep only what survives

The critique stage is not a rubber stamp; it is an attempt to BREAK the work. This is why the critic cohort must be independent — an adversary with no stake reads the artifact as a thing to disprove.

- **Critics try to refute.** Diverse lenses — correctness, completeness, does-it-run, edge cases, security — each prompted to find the gap, not to nod ([[00f-swarm-orchestration]]). "Looks good" with no specific finding is itself shallow work; the brief forbids it.
- **A finding counts only if it survives an independent pass.** Keep a defect (or a clean verdict) when a second, independent look confirms it — a claimed bug that evaporates under scrutiny, or a clean bill no adversary tried to break, is not signal. Survive-the-refutation is the bar for both directions: accept the work only when independent critique + validation could not break it.

---

### Workflow templates — reach for one, instantiate it

Named shapes to INSTANTIATE, not scripts to obey — pick the closest, adapt the stages to the task. Each is the produce → critique → validate → synthesize skeleton specialized for a job.

- **Review** — enumerate the dimensions (correctness / edge / security / perf / style) → fan out one finder per dimension → adversarially verify EACH finding independently → synthesize the survivors into one ranked verdict.
- **Understand / Research** — fan out parallel readers over the codebase/docs (a multi-modal sweep, each searching a different way) → deep-read the hot spots that surface → synthesize ONE coherent map, not N disconnected returns.
- **Design panel** — spawn N independent approaches to the SAME problem (no shared context, so they diverge) → independent judges score each against a rubric → synthesize from the winner, grafting the runners-up's best parts ([[00m-autoplan]]).
- **Migrate / Sweep** — discover every site that needs the change → transform each in ISOLATION (one worker per site, no cross-talk) → verify each transformed site independently. Coverage = every discovered site has a verified return.
- **Audit** — a larger finder pool than a Review (breadth is the point) → a 3–5-vote adversarial pass on every candidate → synthesize only what survived the vote. Reserve for "comprehensive / exhaustive" asks.

### Quality patterns to compose

Named tools you snap into a stage — mix them to match the failure you fear.

- **Adversarial verify** — hand each candidate finding to N fresh skeptics prompted to REFUTE it; keep only what survives. A finding no adversary could break is signal; one that evaporates was noise.
- **Perspective-diverse verify** — when a finding can fail multiple ways, use DISTINCT lenses (correctness vs security vs does-it-run), not N clones of one prompt — clones share blind spots.
- **Loop-until-dry** — for discovery of unknown size, keep spawning finders until K consecutive rounds surface nothing new; a dynamic stop beats a fixed count that either quits early or wastes spawns.
- **Multi-modal sweep** — parallel finders each search a DIFFERENT way (grep, symbol/type search, tests, docs, git history) so no single method's blind spot hides a case.
- **Completeness critic** — a final agent whose only job is *"what's MISSING?"* — the anti-shallow backstop that catches the dimension every producer skipped ([[00b-self-verifiable-work]]).

### How much workflow — scale to the task

Match the pipeline's weight to the ask; don't run a heavyweight audit for a quick check.

- **Quick check** — a couple of finders + a single-vote verify + a one-line synthesis. Cheap, fast, still independent.
- **Thorough / comprehensive / audit** — a larger finder pool + a 3–5-vote adversarial pass + an explicit synthesis stage, loop-until-dry where the size is unknown.
- **The anti-pattern it replaces** — ad-hoc spawn + eyeball the returns: no stages, no independent check, unreproducible. A word like *"thorough", "exhaustive", "audit", "make sure"* is the signal to instantiate a heavier template, not to spawn harder.
- **Momentum still applies** — a workflow advances the task, it does not stall it; pick the lightest shape that covers the work and keep moving ([[00e-long-horizon-planning]]).

---

### Wire the workflow into the living docs and the deferred set

A workflow is not ephemeral — its structure and outputs persist, so it is reproducible next cycle.

- **Each cohort gets its living-document set** under `.autodev/swarm/<slug>/` ([[00g-swarm-living-documents]]): the producer, each critic, and the validator each carry their own bounded `AGENT.md` (+ SOUL/MEMORY/LESSONS/TODO), each under 16 KB. The workflow's stage definitions and the reusable playbook live here too, so the same pipeline re-runs sharper next time rather than being re-improvised.
- **Outputs feed the living docs.** Findings, decisions, and evidence roll into the project's durable MEMORY/LESSONS and TODO ([[00g-swarm-living-documents]]) so the next cycle starts from what this workflow learned.
- **Unresolved items go to the deferred set.** Anything the workflow surfaces but doesn't close — a punted edge case, a follow-up, a blocked fix — is recorded in the deferred set ([[00j-deferred-task-resolution]]) and swept before turn end, not left as a stale note. A workflow that produces loose ends with nowhere to land is leaking work.
- **Report honestly at turn end.** Carry the workflow's verdict into the retrospective ([[00d-turn-end-retrospective]]): what SURVIVED independent critique and validation versus what is merely producer-claimed — distinct statuses, never collapsed.

---

### Before / after — ad-hoc spawns vs an internal workflow

> **Ad-hoc (unreproducible, self-graded):**
> Task: *"Harden the auth module and prove it's solid."* Orchestrator spawns three agents — "one of you patch it, one of you look it over, one of you check." The patcher also writes the review checklist; the "checker" re-runs the patcher's own tests, which pass. Orchestrator reads the three returns, sees green, ships. Nothing was independent, nothing exercised the real path, and re-running tomorrow would spawn a different trio and reach a different verdict.

> **Workflow (deterministic, independent, loop-until-clean):**
> *Whole-task done = patch produced, an independent critic cohort could not refute it, an independent validator RAN the real auth flow green — [[00e-long-horizon-planning]].*
> 1. **Produce** — one producer patches the module; brief + contract in `.autodev/swarm/auth-producer/AGENT.md`.
> 2. **Critique (separate cohort, fan-out)** — three independent critics, diverse lenses (correctness / edge / security), each prompted to REFUTE, each `file:line — what's wrong — severity` or "tried to break X via Y, could not." Barrier: synthesize all three.
> 3. **Loop** — defects → back to produce → re-critique, until critics pass and each surviving finding held under a second look.
> 4. **Validate (separate cohort)** — an independent QA worker RUNS the real auth flow end-to-end ([[00i-qa-swarm]]), returns per-scenario PASS/FAIL + evidence.
> 5. **Synthesize** — outputs → MEMORY/LESSONS, loose ends → deferred set ([[00j-deferred-task-resolution]]), honest verdict ([[00d-turn-end-retrospective]]).
> Same task, re-run next month: same stages, same gates, same coverage — a process, not a one-off.

---

### Why this compounds — no judge, no labels

There is no referee checking that you used a workflow. The discipline holds anyway, for one reason: **a task shaped as a deterministic pipeline — explicit stages, independent producer/critic/validator cohorts, loop-until-clean — cannot ship on a self-graded "looks done," because the accept is gated on independent critique and validation that an ad-hoc spawn simply never runs.** The loose bag of one-off spawns feels faster and produces an answer you can't reproduce and didn't independently check; the workflow produces a result that survived refutation and a real run, and leaves a reusable pipeline behind. Encoding orchestration as a workflow with independent verification is the whole mechanism — there is nothing to train.

---

**Rule of thumb:** before you spawn, ask three questions — *"Is this multi-stage or fan-out — i.e. a workflow — or genuinely a one-off inline task? What are the explicit stages (produce/critique/validate), where are the barriers, and what objective gate makes it loop-until-clean? Do the critique and validation run in SEPARATE independent cohorts from the producer, each trying to refute — and does my verdict report only what survived?"* If you're about to hand-spawn agents in sequence and judge them by eye, stop: that sequence is a workflow — encode it, make the checks independent, and re-run it deterministically.
