> **Digest:** Before building a non-trivial plan, harden it via independent multi-lens critique, resolve mechanical forks yourself, and batch taste calls into one approval gate.

## 0.0m Autoplan — Harden The Plan Before You Build

**When to use:** The moment you have a rough plan for a non-trivial task ([[00e-long-horizon-planning]]) and are about to start building — run autoplan FIRST · Any time the user says *"autoplan"*, *"auto-review"*, or *"harden the plan"*. **Autoplan is a plan-HARDENING discipline: take a rough plan, review it through independent multi-lens critique BEFORE any code is written, auto-resolve the mechanical forks via an explicit rubric, and batch only the genuine judgment calls into a SINGLE approval gate. Rough plan in, fully reviewed plan out.**

You already decompose the work ([[00e-long-horizon-planning]]); autoplan does not replace that — it hardens the plan you drew. The failure mode it kills is *build-then-discover*: you start coding on a plan with a wrong assumption, a missing failure mode, or a scope creep baked in, and pay for it in the diff, in review, or in prod. A flaw caught in the PLAN is orders of magnitude cheaper than the same flaw caught downstream. So before the first edit, subject the plan to the same adversarial, independent scrutiny a swarm gives a built artifact ([[00f-swarm-orchestration]], [[00i-qa-swarm]]) — but aimed at the plan, not the code. Then execute it and auto-advance through every step without stalling ([[00-auto-advance]]).

---

### Autoplan reviews a plan; it does not replace planning

You still do the full decomposition — the arc, the milestones, the whole-task "done" ([[00e-long-horizon-planning]]). Autoplan takes that rough plan as INPUT and hardens it: it finds the gaps, the wrong turns, and the unstated scope before they become code. If there is no plan yet, plan first — autoplan has nothing to review until there is one. The output is not a different plan-making method; it is the SAME plan, reviewed, decision-logged, and single-gated.

---

### Multi-lens INDEPENDENT review

Review the plan from several distinct stances, each a fresh reviewer with NO prior-phase context so it cannot rubber-stamp what an earlier pass wrote ([[00f-swarm-orchestration]], [[00k-internal-workflows]]):

- **Strategy / scope** — is this the RIGHT thing? In scope? Does it leverage existing code instead of reinventing? What is explicitly NOT in scope?
- **Engineering** — architecture, a test for each piece, failure modes, security, error paths, deployment. The failure-mode registry and the test-coverage gaps are artifacts, not afterthoughts.
- **Design / UX** — ONLY if the change is user-facing.
- **Developer-experience** — ONLY if it ships a developer surface (API, CLI, SDK).

Run each lens as an INDEPENDENT worker with its own fresh context — the same independence that makes any check trustworthy ([[00b-self-verifiable-work]]); where a lens is high-stakes, add a second independent voice reconciled to consensus (the critic pattern, [[00i-qa-swarm]]). **Scope-gate the conditional lenses cheaply** — skip design on a non-UI change, skip DX on a change that ships no developer surface. Don't pay for a lens the task doesn't need.

---

### Decision principles — resolve forks yourself, don't ping-pong the user

Most findings have one clearly-better resolution. Resolve those yourself with an explicit rubric instead of asking the user each time — the rubric replaces the USER'S JUDGMENT on mechanical forks, NOT the analysis. You still do the full analysis; the rubric only picks the resolution:

- **Completeness** — fix the whole thing, not a slice of it.
- **Whole blast radius** — fix everything the change touches, not just the symptom.
- **Pragmatic / simplest** — two options fix the same thing → take the cleaner one.
- **DRY** — reuse what exists; reject a duplicate.
- **Explicit over clever** — the obvious approach beats a clever abstraction.
- **Bias to action** — converge and build; do not loop the review forever.

---

### Three-tier decision taxonomy — know what to escalate

Every finding is one of three kinds, and the tier decides who resolves it:

- **Mechanical** — one clearly-right answer. Decide SILENTLY via the principles above, log it. No interruption.
- **Taste** — reasonable people could differ. Decide via the principles WITH a recommendation, then surface it at the gate for a quick confirm — you propose, the user disposes.
- **User-challenge** — the review concludes the user's own stated direction or premise is wrong. NEVER decide this unilaterally. Queue it to the gate with your reasoning, the downside risk, and your own blind spots. You MAY challenge the user's premise; you may NOT act on that challenge without them.

---

### One gate, not twenty interruptions

Do NOT interrupt mid-review with a stream of questions — that is exactly the ping-pong autoplan exists to end. Batch EVERY taste-recommendation and EVERY user-challenge into a SINGLE approval gate at the end (one decision surface via the `ask_user` / choice mechanism), then build. The whole win is the compression: many would-be interruptions collapse into ONE gate the user answers once.

---

### Anti-compression — full depth means full depth

A shortcut review is worthless — a lens that says *"looks good"* has reviewed nothing. Hold every lens to the same objective bar as self-verifiable work ([[00b-self-verifiable-work]]):

- You MUST NOT write *"no issues found"* without showing WHAT you examined.
- You MUST NOT compress a lens into a one-line *"looks good."*
- Each lens produces its REAL artifact — specific findings, alternatives considered, the failure-mode registry, the test-coverage gaps. If a lens has no artifact, it did not run.

---

### Nothing dropped; bounded; don't abort

- **Log every auto-decision.** Each mechanical resolution and each recommendation goes into an audit trail in the living docs ([[00g-swarm-living-documents]]) — a plan hardened invisibly is a plan you cannot defend later.
- **Route every deferral.** Anything out-of-scope or punted goes to the deferred set / TODO ([[00j-deferred-task-resolution]]), never silently dropped.
- **Bound the revise loop.** When the plan changes, re-run only the AFFECTED lenses, not all of them; cap it at roughly 3 cycles — beyond that you are polishing, not hardening.
- **Don't bail.** Once autoplan is chosen, harden the plan and reach the gate — abandoning the review half-done leaves the plan neither rough nor hardened.

---

### Before / after — the un-reviewed plan vs the hardened one

> **Un-reviewed:** rough plan for a user-facing export feature goes straight to code. Halfway in you discover it duplicates an existing serializer, has no empty-dataset path, and the user actually wanted CSV not JSON — three reworks, one of them a scrapped morning, and a puzzled user mid-build.

> **Autoplan:** the rough plan is reviewed by four independent lenses. Strategy flags the duplicate serializer (DRY → reuse it, mechanical, logged) and that CSV-vs-JSON was never stated (user-challenge → queued). Engineering finds the missing empty-dataset path (completeness → add a test, mechanical, logged) and a taste fork on streaming vs buffering (recommend buffering, queued). Design lens runs (it IS user-facing); DX lens is scope-gated out. One gate asks the user two things — output format, and confirm buffering — answered once. Then build, on a plan whose gaps were caught while they were still cheap.

---

### Why this compounds — no referee

No one checks that you hardened the plan. It stays honest anyway, for one reason: **a plan run through independent multi-lens critique, with mechanical forks resolved by an explicit rubric and only genuine judgment calls batched to one gate, cannot ship the wrong-assumption / missing-failure-mode / silent-scope-creep bug that an un-reviewed plan carries straight into the diff.** Skipping the review feels faster for one task and taxes every task after it, when the flaw surfaces as rework. Hardening the plan before you build is the whole mechanism — there is nothing to train.

---

**Rule of thumb:** rough plan in → independently reviewed, decision-logged, single-gated plan out; harden before you build.
