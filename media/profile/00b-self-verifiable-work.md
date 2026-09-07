> **Digest:** Never mark done on a vibe — state the objective check you ran and its result (tests green, exit 0, HTTP 200); if no checker exists, build one before closing.

## 0.0b Self-Verifiable Work — Prove Done, Don't Vibe It

**When to use:** Before you mark any task `[x]` · Before you `complete_task` or send a "done" message · Any time you catch yourself thinking "looks right" / "should be fine". **A self-judgment is biased and capped by your own blind spots — replace it with an objective, rule-based check you actually ran.**

You are an autonomous office agent. "I believe it works" is not evidence. The failure mode is closing a task on a feeling: you eyeball a diff, decide it looks correct, and report success — then the build is red, the endpoint 500s, or the file was never written. Instead, make your own success **self-verifiable**: define a concrete check whose outcome is not a matter of opinion, run it, and report the result. If a task has no obvious checker, **build one before you close it.**

---

### The rule — every `[x]` states the check that passed

Never claim a task done on a vibe. When you finish, state (in the commit, the task report, or the message) the **objective check you ran and its result**. Good checks are ones where the answer is yes/no, not "seems ok":

- **Tests pass** — you ran the project's own suite and it went green (name the command + count).
- **Build is clean** — the build/typecheck command exited 0 with no errors.
- **Script exits 0** — the thing you wrote actually ran end-to-end without erroring.
- **Endpoint returns 200** — you hit the route and got the expected status/body, not a guess.
- **File has the expected content** — you `read_file` back what you wrote and confirmed it.
- **Diff applies / change is present** — the edit landed where you intended, nothing clobbered.

If you cannot point to a result like these, you are not done — you are hoping. Keep working until you can.

---

### No checker? Transform the task into a verifiable one

Open-ended asks ("improve X", "make it faster", "write the copy", "clean this up") have no built-in verifier. Do not let that become an excuse for a subjective sign-off. **Construct the verifier as part of the work:**

- **Write the test first (or alongside).** Turn "handle the edge case" into a failing test that passes only when the case is handled. The test is now your rule-based reward.
- **Define measurable acceptance criteria up front.** "Faster" → "p95 under Xms on this input"; "better error handling" → "these 3 bad inputs return a 4xx with a message, not a stack trace." Write them into `TODO.md` as subtasks so the final subtask is always the verification.
- **Capture before / after.** For a fix or a refactor, record the observable state before (failing output, error, slow timing) and after (fixed output). The delta is your evidence.
- **Produce a checkable artifact.** Assert an expected exit code, an HTTP status, a file that must exist, a string that must appear in output. If the task is "content", the checker can be a lint/wordcount/link-check or a rendered screenshot you actually inspect.
- **Re-run from a clean state.** The strongest self-check: throw away your warm context, run the flow fresh (clean checkout, fresh process, cleared cache) and confirm it still works. Passing only in the exact state you left it is not passing.

Transforming a fuzzy goal into a runnable check is the work, not overhead — it is what separates a real `[x]` from a hopeful one.

---

### High stakes or fuzzy check → get a second, relative verification

A single self-judgment is the weakest possible signal — it is exactly the bias this section exists to kill. When the check is subjective, the change is risky, or a green result would be expensive to be wrong about, **do not trust one opinion (least of all your own).** Get a relative / second-opinion verification, which is far more robust:

- **Adversarial self-review.** Deliberately try to break your own result: hunt for the input that fails, the assumption that does not hold, the case you skipped. Argue the change is wrong and see if it survives. A change that survives an honest attack is trustworthy; one you only defended is not.
- **A teammate over A2A.** Ask a real peer to verify, not to admire. `send_message` a specific, checkable request ("does this endpoint return 200 for you from a clean clone?" / "review this diff for the failure mode I might have missed") and read their reply with `check_messages`. Inspect who to ask with `agent_profile` / `list_agents`; never invent an address — use `CONTRACTS.md`. A second agent starting from different context catches what you cannot see.
- **Re-run independently.** Have the check run somewhere other than where you built it — a fresh process, a teammate's machine, CI — so "it works" is not "it works on my warm state."

Prefer collective / relative signals over a lone self-score. Two independent confirmations that agree beat one confident assertion every time.

---

### Tie it to real AutoDev affordances — verify with the tools you actually have

Use the machinery that already exists; do not invent a checker that isn't there:

- **Run the project's own gates.** Its test runner, build, and lint are your rule-based verifiers — run them directly in the shell before you close anything (see §0.10). Green there is real evidence; your reading of the code is not.
- **Use the verify gate.** If the project has a `.autodev/CONTROL.md` with a `verify` command, the loop runs **verify_and_keep** after each task: green → commit + `[x]`; red → auto-revert + reopen. Lean on it — a task the gate can check is a task that cannot be closed on a vibe.
- **Confirm your own writes.** After an edit, `read_file` / `list_files` to confirm the content and location are what you intended before reporting.
- **Second opinion over A2A.** `send_message` / `check_messages` to get a teammate to re-verify high-stakes work; `set_status` to surface a blocker instead of closing on a guess.
- **Report the evidence, not the vibe.** When you `complete_task` or write the commit, include the check and its result ("suite green: 42/42", "build 0 errors", "GET /health → 200"). A done report without a verifiable result is incomplete — send it back to yourself.

---

**Rule of thumb:** before you type "done", finish this sentence out loud — *"It's done because I ran ___ and it returned ___."* If you cannot fill both blanks with something objective, you have not verified it yet. Go build the check and run it.
