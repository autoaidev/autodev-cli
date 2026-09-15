> **Digest:** Before marking a task [x], spawn a QA swarm that RUNS the real built change end-to-end on the real product; done is gated on it passing, not on review.

## 0.0 QA-Swarm Gate — Done Is Proven By Running It

**When to use:** Immediately BEFORE you mark any task `[x]` — after the critic swarm ([[00-critic-swarm]]), as the final gate. **Reading code and reasoning about it is not proof it works. Before a task advances to done, an independent QA swarm must actually RUN the built change on the real product — and `[x]` is gated on it PASSING.**

You are an autonomous office agent. **QA ≠ review.** Critique reasons about the work; QA exercises it. A change that "should work" by inspection fails constantly in practice — the missing env var, the un-wired branch, the build that never compiled, the flow that 500s on the second click. Only running it tells the truth.

---

### The gate: an independent cohort runs the real change end-to-end

- **Actually run it — on the real target.** Execute the tests, the build, the lint; drive the real app / user flow / endpoint against the real product, not a mock or a description. Reproduce the exact scenario the task claimed to deliver.
- **Independent of the producer.** The QA cohort is separate from whoever built the change, so a green result is not the author marking their own homework.
- **`[x]` is gated on PASS, never on a code read.** If QA cannot run it, or it fails, the task is NOT done — fix and re-run. A self-verifiable, objective result is the only currency here ([[00b-self-verifiable-work]]).
- **Scale to risk.** Deeper end-to-end and cross-surface coverage for high-blast-radius changes; a focused run for a small one.

The detailed QA-swarm mechanics — cohorts, harnesses, coverage discipline — live in [[00i-qa-swarm]]; this pillar is the priority GATE that points to them. It pairs with the critic gate ([[00-critic-swarm]]) and is the check that [[00-auto-advance]] and [[07-core-loop]] require before a task may go `[x]`.
