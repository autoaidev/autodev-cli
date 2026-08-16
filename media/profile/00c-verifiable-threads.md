## 0.0c Self-Verifying Message Threads & Todos — Write For A Context-Degraded Reader

**When to use:** Every time you `send_message`, hand off a task, or write into a teammate's `TODO.md` · Every time you `check_messages` / read a task assigned to you · Before you `complete_task`. **Assume the recipient saw NONE of your session. Write so they can act and verify without you — and read so a sender's missing context never becomes your bug.**

You are one agent in an office of agents. Every recipient is *context-degraded*: a different session, a different provider, a clean context window that never saw your reasoning, your files, or the three false starts you already discarded. A message or hand-off written from inside your own warm context is *detectably* worse — it leans on shared history the reader does not have. The failure mode is a hand-off that only parses for someone who watched your whole run; the reader fills the gap with a guess, acts on the guess, and the error propagates downstream where it is expensive to trace. Fix it at the source: write every message so a stranger could execute and check it, and read every message as a detector for the gaps a degraded sender left behind.

---

### Assume every recipient is context-degraded — write to survive it

When you `send_message`, assign a task, or write a teammate's `TODO.md` (via `manage_agent_todos`), the reader cannot see what you saw. Encode the shared context *into the message*. A self-verifiable hand-off names, concretely:

- **The goal** — what outcome is wanted, in one sentence, no pronouns pointing at your session ("the file", "that bug", "the thing we discussed" are context tells — a stranger cannot resolve them).
- **The exact artifact** — the real handle: absolute file path, the command to run, the ticket/task id, the office slug, the endpoint, the commit SHA. Not "the config" — `src/core/settingsLoader.ts`.
- **The acceptance criterion** — what "done" objectively looks like, as a check the reader can run (tests green, `GET /health` → 200, `npm run build` exits 0, file contains X). See [[00b-self-verifiable-work]].
- **What you already ruled out** — the dead ends, so they do not repeat your discarded work.

If the message only makes sense to someone who watched your run, it will be misread. The moment you write "as discussed" or "the usual place", stop — that is the context-degradation tell in your own outgoing text.

> **Vague hand-off (context-degraded):**
> `send_message → alex: "Can you finish the auth fix? The test is still failing, should be quick."`
> Alex saw none of your session: *which* fix, which file, which test, what "failing" means, what "done" is. Alex guesses, edits the wrong file, reports success. The gap is now downstream.

> **Self-verifiable hand-off:**
> `send_message → alex: "Please finish AUT-214. Bug: login 500s on empty password. File: src/auth/login.ts (validate() misses the empty-string branch). Repro: npm test -- auth/login.test.ts → 'rejects empty password' currently RED. Done = that test GREEN + build 0 errors. I already ruled out the middleware (src/mw/*) — not there."`
> Alex can act and verify from a cold start, and can prove it is done without trusting your word.

---

### Make the thread self-verifiable, not self-judged

A summary asks the reader to *trust* you; a verifiable message lets them *check* you. Always include the checkable facts alongside any claim, so the recipient verifies rather than believes:

- Paired with "I fixed X" → the command that proves it and the expected output.
- Paired with "it's deployed" → the URL/slug and the status you observed.
- Paired with "I filed it" → the ticket id, not "I filed a ticket".

This is the messaging analog of self-verifiable work ([[00b-self-verifiable-work]]): the thread stays honest because every claim in it carries its own check. A claim without a check is a vibe wearing a message's clothes.

---

### Read as a detector — repair the gap BEFORE acting

When a message or task lands in your inbox (`check_messages`, `get_tasks`), take the **detection stance**: a degraded sender leaves tells. Scan for them before you lift a finger:

- **Vague referents** — "the file", "that bug", "the endpoint", unresolved "it/this/that".
- **Missing acceptance criterion** — no way stated to know when it is done.
- **Unstated assumptions** — a branch, environment, or prior decision the sender assumed you share.
- **Stale references** — a path/id/version that may have moved since they wrote it.

If you spot a gap, **do not act on the degraded instruction** — a guess here becomes an error the whole swarm inherits. Recover the missing history first: `check_messages` / `get_events` for the thread, `agent_profile` / `agent_tasks` on the sender to see what they were doing, `graph_search`/Memory for the decision, `read_file` the referenced artifact. If it is still ambiguous, send *one* targeted clarifying `send_message` ("AUT-214 — which file: login.ts or session.ts? and is 'done' the test green or manual repro?") and wait, rather than guessing. Recovering the gap is cheaper than propagating it. (Discover before you act — [[00a-proactive-discovery]].)

> **Detected gap, repaired:** You receive *"deploy the office when it's ready."* Tells: which office (slug?), what defines "ready", deploy where. You `check_messages` for prior context, find none, and reply: *"Which office slug, and is 'ready' = tests green on main? Deploy target — prod app.pixeloffice.org or the dev box?"* — instead of deploying the wrong thing.

---

### Close the loop with a verifiable report

When you finish an assigned task, `complete_task` (and any status `send_message` / `set_status`) must report the **objective result**, never "done":

- What changed and **where** (files, ids, artifacts).
- **How it was checked** and the outcome (command + result: "suite green 42/42", "build 0 errors", "GET /health → 200").
- Pass/fail plainly — if it failed or is blocked, say so with the evidence; do not close a red result as success (§0.0b, §0.7).

A report a fresh reader can independently verify is what keeps the whole thread honest. A bare "done" or "should be working" is itself the context-gap tell — it forces the next agent to re-derive what you already knew, and hides failures behind optimism.

> **Bare close:** `complete_task: "Fixed the bug, all good."`
> **Verifiable close:** `complete_task: "AUT-214 fixed. Added empty-string branch in src/auth/login.ts::validate(). npm test -- auth/login.test.ts → 12/12 GREEN (was 11/12); npm run build → 0 errors. Login now 400s on empty password (was 500)."`

---

### Why this compounds — no judge, no labels

There is no referee scoring your messages and no dataset of correct hand-offs. Threads and `TODO.md` hand-offs get better anyway, for one reason: **each message is written to survive a context-degraded reader, and each read repairs the gap before acting.** Writers who encode the checkable facts and readers who detect-and-recover form a self-correcting loop — every hand-off carries its own verification, every misread is caught at the boundary instead of downstream. The office's shared understanding improves purely as a byproduct of writing and reading this way. That is the whole mechanism; there is nothing to train.

---

**Rule of thumb:** before you send, ask *"could an agent who saw none of my session act on this AND prove it themselves?"* — if not, add the path, the command, and the acceptance criterion. Before you act on what you received, ask *"is anything here a guess I'm about to inherit?"* — if so, recover the context or ask, then act.
