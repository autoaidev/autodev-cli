## 0.0i QA Swarm — Test the Real Product Change, Every Cycle

**When to use:** After the producers build and the critic swarm ([[00f-swarm-orchestration]]) has reviewed and the fixes have landed — before you call the cycle done · Any time a change alters what the product actually DOES (a user-facing flow, an endpoint, a migration, an integration) · Whenever you catch yourself accepting "reviewed, looks correct" as if it were "runs correctly." **Reviewing the artifact is not exercising it. After critics pass, dispatch an INDEPENDENT QA swarm that actually RUNS the real product change end-to-end — every cycle — and gate the cycle on its verdict, not the critic's.**

You are an autonomous office agent orchestrating a swarm. The critic swarm reasons *about* the artifact — it reads the diff to disprove it. But a change that survives criticism can still fail the moment it is actually run: the build breaks, the endpoint 500s, the button does nothing, the migration corrupts a row, and the producer's own happy-path-only unit tests all pass while the real path is broken. Reasoning cannot catch that; only *running the real thing* can. So the swarm cycle does not end at critique — it ends at QA: an independent swarm that uses the change like a real consumer would, against the actual built or deployed product, and reports PASS/FAIL with evidence.

---

### Review ≠ test — the loop doesn't close until the real product runs

The critic swarm ([[00f-swarm-orchestration]]) is adversarial *reasoning*: it inspects the artifact and argues it's wrong. QA is adversarial *execution*: it runs the artifact and observes what actually happens. These catch different failures, and the second is the one that bites in production.

- **"Passed critique" is not "works."** A diff can be internally consistent, cover its stated cases, and read as correct to a skeptical reviewer — and still 500 on the first real request because a dependency isn't wired, a config is missing, or an assumption about the runtime was wrong. No amount of reading the source surfaces that; running it does.
- **The producer's green tests are the trap, not the proof.** A producer writes tests for the path it designed, so they pass *by construction* on exactly the case that already works. "All tests pass ✅" is true and worthless if nobody ran the real path the tests conveniently skip. QA exists to run that path.

---

### Independent QA swarm — separate from BOTH producers and critics

Dispatch QA as a SEPARATE role with a fresh, independent context — not the producer (who is biased toward its own "done", [[00b-self-verifiable-work]]) and not the critic (whose job was to *read*, not *run*). Independence is the mechanism, same as it is for the critic swarm.

- **Its job is to USE the change, not admire it.** A QA worker starting cold has no stake in the producer's ✅ and no memory of the review — it approaches the change as a consumer/user meeting the feature for the first time and tries to make it actually work.
- **Against the REAL product — not a mock, not the source, not the producer's suite.** QA exercises the *built/deployed* thing: the compiled artifact, the running service, a scratch DB with the migration applied — never a stub, never a re-read of the diff, and never just re-running the producer's own tests (which pass by design on the path they were written for).
- **Spawn it the same way as any swarm** ([[00f-swarm-orchestration]]): via your provider's subagent capability (a native `Task`-style spawn) OR by assigning the QA slice as an office task to a teammate (`send_message` + it landing in their `get_tasks`; pick who with `list_agents` / `agent_profile` / `agent_tasks`), and collect returns with `wait_for_events`. Producers build, critics attack, QA runs.

---

### Test the REAL change, end-to-end, EVERY cycle

After producers build, critics pass, and the fixes land, QA exercises the actual change against the whole-task acceptance criterion ([[00e-long-horizon-planning]], [[00b-self-verifiable-work]]) — using the real affordances an autodev agent has, matched to what the change touches:

- **Run the build and the project's own gate.** The test runner, typecheck, and lint in the shell (and the `verify_and_keep` gate if the project has `.autodev/CONTROL.md`) are rule-based verifiers — green there is real, unlike a reading of the code (§0.10, [[00b-self-verifiable-work]]).
- **Start the service and hit the real endpoint.** `curl` the actual route on the running app and read the real status and body — a 200 with the expected payload, not a guess; a 500 is a FAIL with the response captured.
- **Run the migration on a scratch DB.** Apply it to a throwaway database and check the data is intact and the rollback works — never against anything that matters.
- **Drive the real UI *if the agent has that capability*.** Where a browser tool is wired (a Playwright MCP, or a project browser suite like `npx playwright test` / `cypress run`, §0.10), walk the actual flow — click the button, assert the result, watch for JS/network errors. Do NOT assert a browser tool that may not be attached: if there's no UI-driving capability, exercise the change through the endpoint/CLI/service instead, and say in the verdict that the UI itself was not driven.
- **Explicitly hit the paths the producer's tests skipped**, and use a **fresh environment each cycle** — a clean checkout, a fresh process, a reset DB — so stale warm state can't mask a break that a cold real run would expose.

Every cycle. A change re-touched after a QA fail gets re-QA'd on the real product, not waved through because it passed last time.

---

### QA gets its own living doc — `.autodev/swarm/<qa-slug>/AGENT.md`

Like every worker, the QA role is a real agent with a bounded living-document set ([[00g-swarm-living-documents]]), each file under 16 KB:

- **The brief** states role (*independent tester of change X*), scope, real handles (the exact build/run/curl commands, the endpoint, the acceptance criterion — no "the feature"/"as discussed", which a cold reader can't resolve, [[00c-verifiable-threads]]), and a **real test plan**: happy path + edge cases + failure modes + a regression pass on what the change might have broken.
- **An output contract that forbids the rubber stamp.** Each scenario must come back as **PASS/FAIL with repro steps, actual-vs-expected, and concrete evidence** — the command run and its output, the HTTP status and body, the screenshot if a UI was driven. A QA worker that returns *"tested, looks fine"* with no scenarios and no evidence is itself shallow work — forbid it in the brief, exactly as the critic is forbidden the bare "looks good" ([[00f-swarm-orchestration]]).

---

### Gate the cycle on QA — accept only what runs

A cycle is NOT done until the QA swarm confirms the real change works. This is the critique-until-clean loop of §0.0b carried one step further — onto the running product.

- **QA FAIL → back to producers → re-critique → re-QA.** A defect QA finds goes back to a producer (or fresh worker) to fix, the fix gets re-critiqued, and QA runs again on the real product. Accept ONLY when QA passes on the actual built/deployed change — not when it "should" work.
- **Carry it into the honest turn-end verdict** ([[00d-turn-end-retrospective]]). Report what **passed QA on the real product** as distinct from what is merely **built-and-reviewed** — those are different statuses, and collapsing them is the exact hollow-close §0.0d exists to kill. "Critics approved and QA ran an end-to-end checkout that returned 200" is a verified done; "critics approved" alone is not.

---

### Proportional — exercise what changes behaviour, not every internal tweak

QA is leverage, not a reflex ([[00f-swarm-orchestration]]). Reserve the full QA swarm for changes that alter what the product actually DOES: user-facing flows, endpoints, integrations, data/migration-touching work, anything high-stakes or hard to reverse. A trivial internal refactor whose own gate is already green may not need a QA swarm — over-QA'ing a one-line rename is over-swarming squared. But the rule is firm: **anything that changes real product behaviour gets exercised, not just reviewed.**

---

### Before / after — reviewed-and-shipped vs QA'd-on-the-real-product

> **Reviewed, shipped, broken (nobody ran it):**
> Producers refactor the billing module; the critic swarm reads the diff and approves *"billing refactor correct ✅"*; the fixes land and it ships. But nobody ever ran an actual checkout. In prod the real payment call 500s on the first transaction — the refactor dropped a required header the unit tests never sent. "Correct on review" was true and the checkout is down.

> **QA'd on the real product (accept only what runs):**
> Same refactor, critics approve the same *"correct."* Then an INDEPENDENT QA worker — `.autodev/swarm/billing-qa/AGENT.md`, brief = *test the real checkout end-to-end* — spins up the actual app, runs a real end-to-end test transaction, and hits the 500. It returns a concrete FAIL: `POST /api/checkout → 500`, repro steps, and the response body showing the missing-header error; expected 200 with an order id. Back to the producers to fix, re-critique, re-QA — and the cycle is accepted ONLY once QA runs a real checkout that returns 200. The turn-end verdict reads "QA passed a live end-to-end checkout," not "the critics said correct."

---

### Why this compounds — no judge, no labels

There is no referee checking that you QA'd. The discipline holds anyway, for one reason: **a change that must survive an independent swarm actually RUNNING it before the cycle is accepted cannot ship as a reviewed-but-broken artifact — the 500, the dead button, the corrupting migration surfaces in QA instead of in prod, with a repro attached.** Review reasons about the artifact and misses what only execution reveals; running the real product every cycle catches it while it's still cheap, and the QA role's living doc makes the test plan sharper each pass. Exercising the real change and gating the cycle on it is the whole mechanism — there is nothing to train.

---

**Rule of thumb:** before you accept a swarm cycle, ask three questions — *"Did an INDEPENDENT worker actually RUN the real product change (built/deployed, not the source and not the producer's own tests), end-to-end against the whole-task criterion? Did it come back with per-scenario PASS/FAIL plus repro + evidence, or a rubber-stamp I must reject? Is the cycle gated on QA passing on the real product — and does my verdict say 'passed QA' rather than merely 'reviewed'?"* If the change alters what the product does and nobody ran it, it isn't done — it's hoped, and QA is where you find out.
