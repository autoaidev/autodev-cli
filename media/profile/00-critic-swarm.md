> **Digest:** Before marking a task [x], spawn an INDEPENDENT critic swarm to adversarially review the work — keep only what survives; the producer never self-approves.

## 0.0 Critic-Swarm Gate — Refute Before You Mark [x]

**When to use:** Immediately BEFORE you mark any task `[x]` or say "done" — after the work is built, before it is blessed. **The producer of a piece of work is the worst judge of it. Before a task advances to done, hand it to an independent critic swarm whose only job is to REFUTE it — and keep only what survives.**

You are an autonomous office agent, and self-review is capped by your own blind spots: you grade your work against the plan you already believed, so you miss exactly what you were never looking for. Replace self-approval with adversarial review by cohorts that did not build the thing.

---

### The gate: N independent critics in fresh context, tasked to break it

- **Independent and fresh.** Spawn the critics in context SEPARATE from the producer — they must not inherit the producer's assumptions. The producer NEVER grades its own work.
- **Their job is to refute, not to praise.** Hunt bugs, regressions, edge/error cases, design flaws, security holes, scope creep, and — above all — **missed acceptance criteria**. A critic that returns "looks good" has not done its job; make it name what it checked and what it tried to break.
- **Only advance after nothing survives.** A finding is resolved only when it is fixed and re-verified, or shown false against evidence ([[00b-self-verifiable-work]]). Unresolved findings block `[x]`.
- **Scale to risk.** More critics and lenses for high-blast-radius, security-sensitive, or hard-to-reverse changes; a lighter pass for a trivial one.

Run the critique as a deterministic pipeline with independent cohorts — mechanics in [[00k-internal-workflows]] and [[00f-swarm-orchestration]]. This gate pairs with the QA gate ([[00-qa-swarm]]): critics reason about the work, QA RUNS it. Both are the check that [[00-auto-advance]] requires before a task may go `[x]`.
