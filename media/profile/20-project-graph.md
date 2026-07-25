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
| `graph_map` | **Cold start — call this FIRST when you have no id/name in hand.** Ranks the graph's connectivity **hubs** by degree and bundles the **open questions**, **freshest decisions**, and **live contradictions**, each with a one-line summary. The "where do I start" entry point; then expand a hub with `graph_neighbors` or dig an intent with `graph_search`. |
| `graph_search` | **Reasoning-based, best-first, citable retrieval** (vectorless — *you* are the reasoner). Give it an `intent`; it seeds a relevance-ranked query, then best-first expands a relevance-priority frontier (preferring strong provenance edges), and returns a ranked bundle of ≤`node_budget` nodes. Each row cites `[id]` with a one-line WHY — matched terms + the edge-path from its seed — plus contradiction/inference flags. Read the ~12 summaries and reason over them (the optional LLM-rerank is *your* job). |
| `graph_neighbors` | **At task start** — resolve an entity/node by id or name and expand 1–3 hops to recall what's already known *before* acting. This is context construction, not a dump. Results are ranked (center → hop-proximity → recency) and filled to a `token_budget` (default 1500); anything over budget is reported as `…N more nodes / M edges omitted`, never silently dropped. Contradictions and unverified inferences are flagged inline. |
| `graph_query` | Search nodes by type and/or text — now **relevance-ranked** (vectorless TF·IDF over name/summary/aliases/body, lifted by recency + connectivity). A multi-word intent uses OR-semantics, so a near-miss no longer returns empty and the most *relevant* node outranks the merely most *recent*; exact-substring matches are always included. `mode:'recent'` restores pure recency. Long bodies are truncated *explicitly* with `…(+K chars — full via graph_query id=…)`. |
| `graph_add_node` | Record a typed fact and get its id. **SHOULD pass a one-line `summary`** on substantial nodes (see below). |
| `graph_add_edge` | Link two nodes with a typed, sourced relationship (validated against the edge ontology below). |
| `graph_supersede` | Version a fact that changed (old node stays addressable). |
| `graph_stats` | Health + telemetry — gaps, isolated nodes, contradictions, open questions, **summary coverage (unsummarized / stale)**, log size / dead-weight ratio, replay time, estimated tokens, and any corrupt log lines. |

### Summaries — the navigation enabler

Pass a **one-line `summary`** on substantial nodes (`entity`, `decision`, `question`,
`artifact`, `agent_run`). You already hold the context at write time, so it's the
cheapest place to capture the gist — and it rides your provenance like any write.
Summaries power ranking (a high-weight field), the cold-start `graph_map`, and every
render. Interior/hub nodes *without* an authored summary get a **deterministic
structural rollup** (child type counts + top child names by degree — no LLM call).
A summary goes **stale** when its node is superseded or gains children afterwards;
`graph_stats` surfaces `unsummarized` and `staleSummaries` so the swarm can top them up.

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

- **Start of a non-trivial task:** if you already know the entity, `graph_neighbors` on
  it; if you *don't* know where to start, `graph_map` for the hubs/questions/decisions,
  or `graph_search` with your intent for a ranked, citable bundle. Load prior claims,
  decisions, and artifacts — don't rebuild the world from scratch.
- **While working:** record what you learn as you learn it —
  `claim`s (with a source), `decision`s (what/why), `artifact`s (with version),
  `evaluation`s (with rubric), and the `entity`s/`task`s they concern. Link them
  (`supports`, `contradicts`, `depends_on`, `produced`, `derived_from`, …).
- **When a fact changes:** `graph_supersede` rather than overwrite — keep the history.
- **Open questions & conflicts:** add a `question` node, or a `contradicts` edge, so
  the next agent picks it up. Run `graph_stats` to find isolated/unlinked facts.

**Goal:** every important output is traceable to an objective, a source, a graph path,
an evaluation, and a run. When that holds, the swarm's memory compounds instead of resetting.
