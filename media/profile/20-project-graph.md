## 0.20 Project Graph — Durable Shared Memory (`.autodev/graph/`)

**The agent forgets, the graph does not.** The project graph is a typed, queryable
graph of the project's facts and work, persisted at `.autodev/graph/graph.jsonl`
**relative to the project dir**. It survives your session and is **shared by every
agent** in the workspace — what one agent learns, the swarm can read.

> **Graph ≠ memory.** The file memory (`.autodev/memories/`, §0.2) is prose recall
> for *you*. The graph is *structured, sourced, versioned* facts for *everyone*,
> across sessions. Use both: memory for narrative, the graph for the shared world model.

### Tools (in the mcp-operate tool list — available to every provider)

| Tool | Use it to |
|---|---|
| `graph_neighbors` | **At task start** — resolve an entity/node by id or name and expand 1–3 hops to recall what's already known *before* acting. This is context construction, not a dump. Results are ranked (center → hop-proximity → recency) and filled to a `token_budget` (default 1500); anything over budget is reported as `…N more nodes / M edges omitted`, never silently dropped. Contradictions and unverified inferences are flagged inline. |
| `graph_query` | Search nodes by type and/or text; returns ids to expand or link. Long bodies are truncated *explicitly* with `…(+K chars — full via graph_query id=…)`. |
| `graph_add_node` | Record a typed fact and get its id. |
| `graph_add_edge` | Link two nodes with a typed, sourced relationship (validated against the edge ontology below). |
| `graph_supersede` | Version a fact that changed (old node stays addressable). |
| `graph_stats` | Health + telemetry — gaps, isolated nodes, contradictions, open questions, log size / dead-weight ratio, replay time, estimated tokens, and any corrupt log lines. |

### Schema

**Node types:** `entity` · `claim` · `source` · `artifact` · `agent_run` ·
`evaluation` · `task` · `commit` · `metric` · `note` · `question` · `decision`.
Entities dedupe by name (idempotent — re-adding merges aliases), so resolve real
things (services, files, people, modules) as entities. Dedup is by a **canonical
key** (a sorted token-set), so `UsageService`, `usage-service` and `usage service`
all resolve to **one** entity id — spelling/casing/word-order no longer forks it.

**Edge types:** `mentions` · `supports` · `contradicts` · `derived_from` ·
`produced` · `evaluates` · `revises` · `supersedes` · `depends_on` · `parent_of` ·
`resolved_to` · `relates_to`.

**Edge ontology (validated on write).** Obvious type mismatches are rejected with a
message listing what the relation expects: `produced: agent_run→artifact` ·
`evaluates: evaluation→{artifact,agent_run}` · `supports`/`contradicts: *→claim` ·
`resolved_to: *→entity`. The rest (`derived_from`, `parent_of`, `depends_on`,
`mentions`, `relates_to`, `revises`, `supersedes`) accept `*→*`.

### Invariants (enforced on write — a rejected write tells you what to add)

1. Every **claim** has a `source` (`"file:line"` / url / source-node id) **or** `inference: true`.
2. Every **artifact** has a `version`.
3. Every **evaluation** names the `rubric` it judged against.
4. **Superseded nodes are never deleted** — they stay addressable; `graph_supersede` links the replacement with a `supersedes` edge.

Provenance (your run id + agent id + timestamp) is attached to every write automatically.

### How it folds into the core loop

- **Start of a non-trivial task:** `graph_neighbors` on the entities in the task to
  load prior claims, decisions, and artifacts. Don't rebuild the world from scratch.
- **While working:** record what you learn as you learn it —
  `claim`s (with a source), `decision`s (what/why), `artifact`s (with version),
  `evaluation`s (with rubric), and the `entity`s/`task`s they concern. Link them
  (`supports`, `contradicts`, `depends_on`, `produced`, `derived_from`, …).
- **When a fact changes:** `graph_supersede` rather than overwrite — keep the history.
- **Open questions & conflicts:** add a `question` node, or a `contradicts` edge, so
  the next agent picks it up. Run `graph_stats` to find isolated/unlinked facts.

**Goal:** every important output is traceable to an objective, a source, a graph path,
an evaluation, and a run. When that holds, the swarm's memory compounds instead of resetting.
