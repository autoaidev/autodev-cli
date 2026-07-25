## 0.20 Project Graph — Durable Shared Memory (`.autodev/graph/`)

**The agent forgets, the graph does not.** A typed, sourced, versioned graph of the
project's facts/work at `.autodev/graph/graph.jsonl` — **shared by every agent**,
surviving sessions. **Graph ≠ memory** (§0.2): memory is prose recall for *you*; the
graph is the structured world model for *everyone*. Full tool docs live in each tool's
own description — this is the when/why.

### Tools (mcp-operate — every provider)
- `graph_map` — **cold start, no id in hand.** Pinned core + top hubs + open questions + fresh decisions + live contradictions. "Where do I start."
- `graph_toc` — navigable table-of-contents tree (spine = `parent_of`, auto-built from `file:line` sources); `root=<id>` drills a branch.
- `graph_search` — reasoning-based, citable retrieval: give an `intent`, get a ranked bundle each citing `[id]` + why. *You* reason over the summaries.
- `graph_neighbors` — at task start, expand an id/name 1–3 hops (ranked, token-budgeted, contradictions flagged). `summarize:true` returns a branch's rollup.
- `graph_query` — relevance-ranked search by type/text (vectorless; `mode:'recent'` for pure recency).
- `graph_add_node` — record a typed fact; **pass a one-line `summary`** on substantial nodes; cite a `file:line` `source` (auto-builds the tree); `pinned:true`/`props.area` optional.
- `graph_add_edge` — typed, sourced link (validated against the edge ontology).
- `graph_supersede` — version a changed fact (old stays addressable). `graph_rollup` — summary node for a cluster. `graph_pin` — mark a core invariant. `graph_stats` — health/telemetry.

### Schema
Nodes: entity · claim · source · artifact · agent_run · evaluation · task · commit · metric · note · question · decision. Entities dedupe by a canonical token-set key (`UsageService` = `usage-service` = `usage service`). Edges: mentions · supports · contradicts · derived_from · produced · evaluates · revises · supersedes · depends_on · parent_of · resolved_to · relates_to.

### Invariants (enforced on write)
1. A **claim** needs a `source` (`file:line`/url/id) or `inference:true`. 2. An **artifact** needs a `version`. 3. An **evaluation** needs a `rubric`. 4. Superseded nodes are **never deleted** (stay addressable). Provenance (run+agent+ts) is auto-attached.

### Loop-fold
- **Task start:** know the entity → `graph_neighbors`; don't → `graph_map` or `graph_search <intent>`. Recall before acting.
- **While working:** record facts as you learn them — claims (with source), decisions (what/why), artifacts (with version), evaluations (with rubric) — and link them. Cite `file:line` so the tree fills itself; pass a `summary`.
- **Changed fact:** `graph_supersede`, don't overwrite. **Conflicts/unknowns:** add a `question` node or a `contradicts` edge. Pin a *few* core invariants.

**Goal:** every important output traces to an objective, a source, a graph path, an evaluation, and a run — so the swarm's memory compounds instead of resetting.
