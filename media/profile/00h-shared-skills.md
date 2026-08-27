## 0.0h Shared Skills — Create, Discover, Use, Update

**When to use:** The moment you face a non-trivial task that FEELS familiar — "I (or someone) worked this out before" · Right after you finally crack a fiddly, gotcha-laden procedure and think "I never want to re-derive that" · Whenever you follow a shared skill and it steers you slightly wrong or leaves a gap. **A skill is a reusable, packaged capability the whole office shares. Discover an existing one before you re-invent; capture a proven recurring procedure as a new one; and when a skill you used is wrong or incomplete, UPDATE it — skills are living documents, not write-once files.**

Skills follow Anthropic's Agent Skills protocol (`github.com/anthropics/skills`). A skill is a self-contained folder whose `SKILL.md` carries YAML frontmatter — `name` (a kebab-slug) and `description` — plus instructions below, and optional bundled scripts/templates/reference files. The `description` is the load trigger: it is the ONLY part always in the model's context, and it is what the model reads to decide WHEN to pull the skill in. So it must state both WHAT the skill does and WHEN to use it, in the terms a future agent would be thinking. That is **progressive disclosure**: the description is always scannable → the full `SKILL.md` loads only when a task matches → bundled files load only when the `SKILL.md` references them. A skill is the office's way of not re-solving a solved problem.

---

### Where skills live — authoring source vs provider load path

Two paths, one relationship — do not conflate them:

- **`.autodev/skills/<slug>/SKILL.md` — the shared authoring SOURCE.** This is the durable, office-shared library, in the same `.autodev/` tree as the graph (`.autodev/graph/`), issues (`.autodev/issues/`), and swarm briefs (`.autodev/swarm/`, [[00g-swarm-living-documents]]). You create, read, and edit skills here with your normal file tools. It is where a skill *lives* as a team asset.
- **`.claude/skills/<slug>/SKILL.md` — the provider LOAD path.** A Claude-Code provider only auto-loads skills from `.claude/skills/`, so a shared skill is deployed/synced there for the runtime to pick up (Claude re-reads skills each run — no relaunch). Providers that cannot load `SKILL.md` (opencode/grok/copilot) instead receive the skill folded as prose into `AGENTS.md`, so every agent benefits regardless of provider.

The relationship is source → deployed copy, exactly like the CLI-bundled skills that ship under `media/skills/` and are copied into `.claude/skills/` on startup. Author in the shared source; the sync puts it where the provider loads it. Never treat the deployed `.claude/skills/` copy as the master — edit the source and let it propagate, or your fix is overwritten on the next sync.

---

### When to create a skill — and when NOT to

Create one when you have **worked out how to do a non-trivial, RECURRING task well** and don't want yourself or a teammate to re-derive it: a proven multi-step procedure, a gotcha-laden workflow, an integration with undocumented behaviour, a deploy dance with a non-obvious ordering. The signal is "I just spent real effort getting this right, and this shape of task will come back."

Keep it distinct from the neighbouring durable stores:

- **Memory (§0.2, `.autodev/MEMORY.md` + `.autodev/graph/`)** holds durable *facts* — this service listens on that port, this key means that.
- **Lessons (`.autodev/LESSONS.md`)** holds *corrections* — what went wrong and what to do differently.
- **A skill** holds an executable *PROCEDURE / capability* — the ordered how-to a future agent RUNS to get the task done.

Do NOT skill-ify one-offs. Over-skilling is clutter: a library full of narrow single-use skills makes the *right* skill harder to find and dilutes every `description` the model scans. If it won't recur, a Memory node or a Lesson is the right home, not a skill.

---

### How to author it well

A skill is only as good as a context-degraded future reader can act on ([[00c-verifiable-threads]]) — write for an agent who saw none of your run:

- **Nail the `description`.** It is the load decision. State WHAT it does + WHEN to use it + the trigger terms a future agent would actually think ("deploying service X", "the migration fails with lock timeout"). A vague description ("helper for deploys") never loads at the right moment; a precise one fires exactly when needed.
- **Keep `SKILL.md` focused and UNDER 16 KB** — the same hard cap every profile pillar and swarm living-doc obeys ([[00g-swarm-living-documents]]), because the loaded file is read straight into context. Progressive disclosure is the tool: push long detail — reference tables, sample configs, edge-case catalogues — into bundled files beside `SKILL.md` and point at them, so they load only when actually needed instead of bloating every trigger.
- **Make it runnable.** Concrete ordered steps, real handles (absolute paths, exact commands, expected output), worked examples, and any helper scripts bundled in the folder. A skill that says "configure it appropriately" is not a skill.
- **Self-contained.** No "as we discussed", no dangling references — a cold reader must be able to follow it end to end.

---

### Discover & use — before you re-invent

Before a hard or familiar task, **scan the shared skills library** (`.autodev/skills/`) the way you run any discovery sweep ([[00a-proactive-discovery]]): read the descriptions, and when one matches, load its `SKILL.md` and follow it. This is discover-before-reinvent applied to procedures — the whole point of a shared library is that the second agent to hit a problem pays the cost of *reading* a skill, not the cost of re-deriving the solution. Checking the library is cheap; re-solving a solved problem is not.

---

### Share & UPDATE — the collaborative core

Skills are **SHARED**: one agent's skill is available to the whole office, and the office keeps every agent's effective skill set in sync — pushed to each workspace over the `skill_update` channel and deployed to the provider load path. So authoring a good skill is a gift to every teammate, and a bad or stale one misleads all of them.

Because they are shared, they must be **LIVING documents**:

- **When a skill you used is wrong, incomplete, or improvable, UPDATE its `SKILL.md`** — fix the broken step, add the gotcha you just hit, add the missing example, sharpen the `description` so it loads at the right time. The next agent inherits your fix instead of re-hitting your bug. This mirrors how swarm roles sharpen each pass ([[00g-swarm-living-documents]]).
- **Update, don't silently fork.** Cloning a skill to `deploy-x-v2` and quietly diverging splits the team's knowledge and rots both copies. Improve the canonical one; if behaviour genuinely diverged, supersede in place with a dated update, never a shadow copy.
- **Verify before sharing and after every update** ([[00b-self-verifiable-work]]). A skill whose `description` promises one thing while its steps do another is worse than no skill — it loads at the wrong time and sends readers down a wrong path with false confidence. Actually run the procedure (or a clean re-run) and confirm the `description` still matches the behaviour before you leave it in the shared library.

---

### Skills + swarms

Skills and swarms compound ([[00f-swarm-orchestration]]). When you dispatch a worker, **hand it the relevant skill in its brief** — name the `.autodev/skills/<slug>/` to load — so it starts from the proven procedure instead of re-deriving it in a fresh context. And run the flow in reverse: when a swarm ROLE proves itself across several dispatches — the `migrator`, the `auth-auditor` — **promote its stabilised playbook into a shared skill** so the capability outlives any single swarm and any agent can pick it up. A recurring worker playbook ([[00g-swarm-living-documents]]) that has earned its keep is a skill waiting to be extracted.

---

### Before / after — re-deriving vs loading-and-improving

> **No skill (re-derive every time, repeat the mistake):**
> The deploy of service X needs an env var exported, a cache primed, and migrations run BEFORE the release flip — a non-obvious order. An agent works it out painfully, ships, and moves on, writing nothing down. Three weeks later a different agent hits the same deploy, doesn't know the order, flips the release before the cache is primed, and takes the same outage the first agent already suffered. The knowledge died in a context reset; the office paid for it twice.

> **Shared living skill (load, follow, improve):**
> The first agent captures it as `.autodev/skills/deploy-x/SKILL.md` — `description: "Deploy service X safely. Use when releasing X: covers the env-var/cache-prime/migrate ordering that causes an outage if flipped early."` — with the exact ordered commands and a prime-check script bundled alongside, verified against a real deploy ([[00b-self-verifiable-work]]). Weeks later the second agent, before touching the deploy, scans the library ([[00a-proactive-discovery]]), the `description` matches, loads the `SKILL.md`, and follows it — no outage. They hit ONE new edge (a new region needs a second cache primed), so they UPDATE the skill: add the step, add the region to the `description`. The third agent inherits both fixes. The procedure got *sharper* with use instead of dying with its author — and every agent, on every provider, has it.

---

### Why this compounds — no judge, no labels

Nobody grades your skill library. The discipline holds for one reason: **a proven procedure captured once as a shared, well-described, verified skill is paid for once and reused by every agent forever — and because it's a living document, each use that finds a gap makes it better for the next reader instead of leaving them to re-derive and re-fail.** Re-solving a solved problem feels like progress and is pure waste; discovering the existing skill, following it, and updating it when it's wrong is how the office's competence accumulates instead of resetting with every context window. Author for the load trigger, keep it under the cap, verify it matches its `description`, and update in place — that is the whole mechanism; there is nothing to train.

---

**Rule of thumb:** before a hard or familiar task, ask — *"Is there already a skill for this in `.autodev/skills/`? (discover before re-inventing)"* After you crack a recurring procedure, ask — *"Would a teammate re-derive this? Then capture it as a skill with a `description` that loads at the right moment, verified and under 16 KB."* And after you USE a skill, ask — *"Did it steer me right? If not, UPDATE it in place so the next agent doesn't hit what I just hit."* A solved problem re-solved is the failure this pillar exists to prevent.
