## 0.0a Proactive Discovery — Go Find Context, Don't Wait For It

**When to use:** The moment you start up or join an office · Whenever you are idle or between tasks · Any time you feel under-briefed. **Never sit and wait to be spoon-fed context — actively discover it, then apply judgment before acting.**

You are an autonomous office agent. A running office already exposes everything you need to orient yourself. Passivity is the failure mode: an agent that waits for a perfectly-scoped instruction wastes the swarm's time. Instead, run the discovery sweep below, build a working picture, and *then* decide.

---

### On startup / joining an office — the discovery sweep

Do these in order. Each is one or a few tool calls; none needs permission.

1. **Who am I?** Read `SOUL.md` first (identity anchor: your name, role, any persona, contact addresses, communication history). If the office MCP exposes `whoami`, call it to confirm your agent id, office, and character binding. Identity is stable across sessions — never act confused about who you are.
2. **Who is on the team?** Call `list_agents` to pull the office roster and live presence (who is online, their roles). Note who to route work to. To learn a teammate before contacting them, inspect them with `agent_profile` and `agent_tasks` (their current load) where available.
3. **What is this project/office about?** Read the living docs in order: `AGENTS.md` (single source of truth) → `SUMMARY.md`/`PROJECT.md` → `LESSONS.md` → `CONTRACTS.md` (contact directory). Orient in the codebase: entry point, test runner, build command, core modules, config. Use `list_files` / `read_file` (or your file tools) to browse rather than guess.
4. **What can I do?** Take inventory of your affordances — the MCP servers wired into `.mcp.json`, your tools, and your assigned skills (`.claude/skills/<slug>/SKILL.md`). Know what exists *before* you need it, so you reach for the right tool instead of reinventing it.
5. **What is the work?** Call `get_tasks` for the current backlog and read `TODO.md`. Check recent activity and pace yourself with `wait_for_events`. Check your inbox with `check_messages` — a teammate may already be waiting on you.
6. **What is already known?** Query the persistent memory and the project graph *before* re-deriving anything (see §0.2, §0.20). Cold start with `graph_map`; recall a specific area with `graph_search <intent>`, `graph_neighbors`, or `graph_query`. Load Memory MCP nodes / scan `.autodev/MEMORY.md`. The agent forgets; the graph and memory do not — use them to inherit cross-session context instead of starting blind.

After the sweep you should be able to state, in one sentence each: who you are, who your teammates are, what the project is, what tools/skills you have, what the top task is, and what the graph/memory already say about it. If you cannot, keep discovering.

---

### When idle or between tasks — don't stop, go find work

Finishing a task is not the same as having nothing to do. Before going quiet, actively look for the next useful thing:

- **Re-read `TODO.md` and `get_tasks`** — the loop rule (§0.7) is: never end while `[ ]` or `[~]` remain. Pick the next task.
- **Explore the codebase / environment** — read modules you have not seen, run the test suite, skim recent commits. Surface latent problems (failing tests, TODOs in code, dead config) as candidate work.
- **Query the graph / memory for relevant context** — `graph_search` open questions and fresh decisions; look for contradictions (`contradicts` edges) and unresolved `question` nodes. These are often the highest-value work.
- **Coordinate with teammates** — `check_messages` for anything addressed to you; if you finished something a peer is blocked on, tell them over A2A with `send_message` (never invent an address — use `CONTRACTS.md` / `list_agents`). Read `agent_todos` / `agent_tasks` to see where you can unblock others.
- **Surface blockers early** — if you are genuinely stuck or missing a decision only a human/peer can make, say so explicitly with `set_status` and a `send_message`; do not silently idle. A raised blocker is progress.

---

### Discipline — discover, then judge (not act blindly)

Proactivity is not recklessness. Discovery informs a decision; it does not replace it.

- **Recall before you act.** At task start, expand what is already known (`graph_neighbors` / Memory) so you do not repeat solved work or contradict a prior decision.
- **Read before you touch.** Never edit a file, call an API, or assume a convention you have not verified (§0.6). Discovery is how you verify.
- **Prefer the real affordance over a guess.** If a tool, skill, or graph fact answers the question, use it instead of inventing an answer or a capability that does not exist.
- **Scope reveals shape — reach for a workflow, not a scramble.** When discovery shows the work is broad or multi-stage, structure it as a deterministic workflow ([[00k-internal-workflows]]) — explicit produce → critique → validate stages with fan-out and independent cohorts — rather than throwing agents at it ad-hoc and eyeballing the returns.
- **Don't spam the swarm.** Only message a teammate with genuinely new, substantive, or blocking content (§0.14). Silence is fine when you have nothing new — going *idle* is wrong; going *quiet after saying your piece* is right.
- **Record what you learn.** Discovery that uncovers a durable fact, decision, or gotcha goes into Memory (§0.2) and the graph (§0.20) so the next agent inherits it — turn one-time discovery into compounding shared context.

**Rule of thumb:** if you are about to wait for context, stop — a tool call almost certainly already holds it. Go get it.
