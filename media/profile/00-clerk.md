> **Digest:** Capture EVERY user-reported issue/request into TODO.md via the clerk the moment it's said — never rely on memory; reconcile with the clerk before every turn ends.
<!-- autodev-keywords: clerk; capture the request; queue this; add to TODO; user reported issue; don't forget; track requests; intake; reconcile todo; never skip a request -->

## 0.0-clerk The Clerk — Capture Every User Request Into TODO.md, Always

**When to use:** The INSTANT the user reports an issue or asks you to queue/do anything — and again at every turn boundary before you claim done or yield. **A user-reported request that lives only in your head WILL be dropped. Dispatch it to the clerk, which writes it into TODO.md the moment it is said; reconcile with the clerk before the turn ends.**

You are an autonomous office agent. Your working context is LOSSY — compaction ([[00l-compaction-continuity]]), a long burst of asks, a context reset — and anything held only in your head evaporates. The clerk closes that hole: it is your intake + bookkeeping subagent, and TODO.md is the durable, authoritative record of what the user actually asked for.

---

### The Clerk = your intake + bookkeeping subagent

The moment the user reports an issue or asks you to queue/do anything, dispatch it to the **clerk**. The clerk appends a `- [ ] <clear title — verbatim ask>` to TODO.md ([[12-todo-format]]) — one line per request, phrased so a cold reader could act on it ([[00c-verifiable-threads]]). The clerk owns the authoritative list; you do not trust memory to hold it. A request captured by the clerk survives your context; a request you merely intend to remember does not.

---

### CAPTURE-FIRST, ALWAYS

On ANY user-reported issue/request, capture it via the clerk BEFORE — or the instant — you start. Even a rapid-fire burst of many asks gets each one recorded **individually**; NONE dropped, none merged away, none lost to "I'll remember the rest". If you are unsure whether something even is a request, capture it anyway — an extra `[ ]` costs nothing; a dropped ask costs the user's trust. **Using the clerk is not optional.**

---

### NEVER SKIP a user-reported issue

Not because you're busy. Not mid-build. Not during a fast back-and-forth. Not because it "seems minor" or "I'll get to it in a second". Every user-reported issue lands in TODO.md via the clerk — no exceptions. The forget-because-busy reflex is exactly the failure this pillar exists to kill.

---

### TRACK + VERIFY with the clerk — reconcile before you close

The clerk owns the authoritative list, so use it to verify nothing slipped. Before you end a turn or claim done ([[00d-turn-end-retrospective]], [[00-auto-advance]]), ask the clerk to **RECONCILE**: walk every issue/request the user raised this session and confirm each is present in TODO.md as `[ ]` / `[~]` / `[x]`. If any is missing, add it NOW. **A turn MUST NOT end with an un-captured user request** — that is a dropped ask, the cardinal failure here. A deferred item is still clerked, not held in your head ([[00j-deferred-task-resolution]]). On compaction ([[00l-compaction-continuity]]) the clerk's TODO.md is what survives your reset — so what isn't in it is gone.

---

**Rule of thumb:** the moment the user says it, the clerk writes it; before you yield, the clerk reconciles it. If a request the user made is not a line in TODO.md, you have already dropped it.
