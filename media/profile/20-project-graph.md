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
| `graph_map` | **Cold start — call this FIRST when you have no id/name in hand.** Prepends the **pinned "core" tier** (project invariants), then ranks the graph's connectivity **hubs** by degree and bundles the **open questions**, **freshest decisions**, and **live contradictions**, each with a one-line summary. The "where do I start" entry point; then walk the tree with `graph_toc`, expand a hub with `graph_neighbors`, or dig an intent with `graph_search`. |
| `graph_toc` | **Navigable table-of-contents** — a depth-bounded, summarized hierarchy (the PageIndex text-stripped-overview → drill pattern). The spine is `parent_of` (roots = entities with no incoming `parent_of`, auto-built from `file:line` sources — see below); where the spine is sparse it falls back to deterministic clustering (by `props.area`, else connected components). Each level shows the top nodes by degree and collapses the rest to `+K more`. Pass `root=<id>` to drill one branch. |
| `graph_search` | **Reasoning-based, best-first, citable retrieval** (vectorless — *you* are the reasoner). Give it an `intent`; it seeds a relevance-ranked query, then best-first expands a relevance-priority frontier (preferring strong provenance edges), and returns a ranked bundle of ≤`node_budget` nodes. Each row cites `[id]` with a one-line WHY — matched terms + the edge-path from its seed — plus contradiction/inference flags. Read the ~12 summaries and reason over them (the optional LLM-rerank is *your* job). |
| `graph_neighbors` | **At task start** — resolve an entity/node by id or name and expand 1–3 hops to recall what's already known *before* acting. This is context construction, not a dump. Results are ranked (center → **pinned core** → hop-proximity → recency) and filled to a `token_budget` (default 1500); over budget it **degrades in tiers** — body→name-only, then a branch collapses to its rollup summary — and reports `…N more nodes / M edges omitted`, never silently dropped. Pinned nodes are always prepended. `summarize:true` returns a branch's rollup summary node (see `graph_rollup`) instead of expanding it. Contradictions and unverified inferences are flagged inline. |
| `graph_query` | Search nodes by type and/or text — **relevance-ranked** (vectorless TF·IDF over name/summary/aliases/body, lifted by recency + connectivity). A multi-word intent uses OR-semantics, so a near-miss no longer returns empty and the most *relevant* node outranks the merely most *recent*; exact-substring matches are always included. `mode:'recent'` restores pure recency. Long bodies are truncated *explicitly* with `…(+K chars — full via graph_query id=…)`. |
| `graph_add_node` | Record a typed fact and get its id. **SHOULD pass a one-line `summary`** on substantial nodes (see below). Pass `pinned:true` to add it to the core tier; a `file:line` source auto-scaffolds the `parent_of` tree; a `props.area` tag groups it under an area. |
| `graph_add_edge` | Link two nodes with a typed, sourced relationship (validated against the edge ontology below). |
| `graph_rollup` | **Hierarchical summary node** for a cluster (a centre entity's `parent_of` descendants, else its N-hop neighbourhood). Creates/upserts a deterministic-id node (`summary:<centre-key>`, a `note` with `props.rollup=true`) linked `derived_from → each member` — members stay fully addressable in `props.members`. Pass your own `summary`, or omit for a deterministic no-LLM rollup. Then `graph_neighbors summarize=true` returns it instead of expanding the branch. Re-running upserts the same node (concurrent-safe). |
| `graph_pin` | Pin/unpin a node as project **core** (invariants / working agreement). Pinned nodes are ALWAYS prepended within budget by `graph_map` and `graph_neighbors`. |
| `graph_supersede` | Version a fact that changed (old node stays addressable). |
| `graph_stats` | Health + telemetry — gaps, isolated nodes, contradictions, open questions, **summary coverage (unsummarized / stale)**, **pinned count**, **spineless hubs** (children but no `parent_of` spine), log size / dead-weight ratio, replay time, estimated tokens, and any corrupt log lines. |

### Summaries — the navigation enabler

Pass a **one-line `summary`** on substantial nodes (`entity`, `decision`, `question`,
`artifact`, `agent_run`). You already hold the context at write time, so it's the
cheapest place to capture the gist — and it rides your provenance like any write.
Summaries power ranking (a high-weight field), the cold-start `graph_map`, and every
render. Interior/hub nodes *without* an authored summary get a **deterministic
structural rollup** (child type counts + top child names by degree — no LLM call).
A summary goes **stale** when its node is superseded or gains children afterwards;
`graph_stats` surfaces `unsummarized` and `staleSummaries` so the swarm can top them up.

### Structure & scale (the tree, the core tier, the cache)

**`parent_of` auto-scaffold — the tree fills itself.** When you add a `claim` / `artifact`
/ `decision` / `note` with a `file:line`-style `source` (e.g. `src/auth/token.ts:42`), the
graph **deterministically** (no LLM) upserts `entity` nodes for the file and its ancestor
dirs and links a `dir → file → fact` `parent_of` spine. Derived nodes/edges carry your run's
provenance and `props.autoScaffold=true`, and are idempotent (deterministic ids + edge dedup),
so many agents and re-adds converge instead of duplicating. This is what makes `graph_toc`
navigable — so **cite a `file:line` source** whenever a fact has one.

**`props.area` convention.** Tag a node with `props.area:"<tag>"` to group it under an
auto-created area entity (`entity:area:<tag>`) — a second, orthogonal spine for facts that
aren't file-anchored, and a clustering hint `graph_toc` uses when the `parent_of` spine is
sparse. The reserved **`props.area:"core"`** (or `pinned:true`, or `graph_pin`) marks a node
as a **pinned core invariant**: `graph_map` and `graph_neighbors` always prepend it within
budget. Pin a *few* nodes (the working agreement / project invariants), not many.

**Snapshot cache (cold-start perf).** A materialized `.autodev/graph/graph.snapshot.json`
(`{coversBytes, generatedAt, generatedBy, headSig, nodes, edges}`) lets a fresh store load a
prefix and tail-replay only the uncovered bytes instead of full-replaying the whole log. It is
a **disposable cache** — the JSONL stays the sole source of truth, and a missing / stale /
corrupt snapshot silently falls back to full replay. It regenerates opportunistically (temp
file + atomic `rename`) once the uncovered tail exceeds ~256 KB / 2000 ops; the JSONL is never
rewritten. You don't manage it — it just makes reload cheap on large graphs.

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
