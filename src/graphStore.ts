/**
 * Project Graph — durable, per-project, cross-session shared memory for agents.
 *
 * This is the "knowledge/work graph" from the graph-engineering playbook: a
 * typed, queryable graph of Entities, Claims, Sources, Artifacts, AgentRuns,
 * Evaluations, Tasks, Commits and Metrics, connected by provenance edges. It is
 * DISTINCT from the file-based memory (`.autodev/memories/`) and the Memory MCP:
 * memory is prose recall; the graph is structured, sourced, versioned facts that
 * many agents read and write across sessions. The mantra: the agent forgets, the
 * graph does not.
 *
 * STORAGE. One append-only log per project at `.autodev/graph/graph.jsonl`.
 * Every mutation is a self-contained JSON line carrying its own provenance
 * (run_id, agent_id, timestamp). Current state is materialised by replaying the
 * log. Append-only buys three things the playbook demands: an audit trail,
 * crash safety, and lock-free concurrent writes — several agents in the same
 * workspace simply append their own lines and re-read to see each other's.
 *
 * INVARIANTS (enforced on write, per the playbook):
 *   1. Every `claim` has a source, or is explicitly marked `inference: true`.
 *   2. Every `artifact` has an authoring run (auto) and a `version`.
 *   3. Every `evaluation` identifies a `rubric`.
 *   4. Superseded nodes remain addressable — supersede never deletes; it links a
 *      new version with a `supersedes` edge and flags the old one.
 *
 * MATERIALISATION (Tier 0). The log is append-only, so reload is incremental: we
 * remember a byte offset and apply only the newly-appended tail on top of the
 * live maps (apply is idempotent last-writer-wins) — a full clear+rebuild only
 * happens when the file shrank (a rewrite). Two derived indexes are kept in step:
 * an adjacency index (nodeId → incident edges) and an entity canonical-key index
 * (name → entity id) so `UsageService` / `usage-service` / `usage service` all
 * resolve to ONE entity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type GraphNodeType =
  | 'entity' | 'claim' | 'source' | 'artifact' | 'agent_run'
  | 'evaluation' | 'task' | 'commit' | 'metric'
  | 'note' | 'question' | 'decision';

export type GraphEdgeType =
  | 'mentions' | 'supports' | 'contradicts' | 'derived_from' | 'produced'
  | 'evaluates' | 'revises' | 'supersedes' | 'depends_on' | 'parent_of'
  | 'resolved_to' | 'relates_to';

export const NODE_TYPES: GraphNodeType[] = [
  'entity', 'claim', 'source', 'artifact', 'agent_run',
  'evaluation', 'task', 'commit', 'metric', 'note', 'question', 'decision',
];
export const EDGE_TYPES: GraphEdgeType[] = [
  'mentions', 'supports', 'contradicts', 'derived_from', 'produced',
  'evaluates', 'revises', 'supersedes', 'depends_on', 'parent_of',
  'resolved_to', 'relates_to',
];

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  body?: string;
  props?: Record<string, unknown>;
  /** Where the fact came from (a citation, url, file:line, or a source node id). */
  source?: string;
  /** Claims only: true when the claim is a reasoned inference, not sourced. */
  inference?: boolean;
  /** Artifacts only: the version this node describes. */
  version?: string;
  /** Evaluations only: the rubric the judgement was made against. */
  rubric?: string;
  aliases?: string[];
  /** Set when a newer node supersedes this one; the node stays addressable. */
  supersededBy?: string;
  runId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  from: string;
  to: string;
  props?: Record<string, unknown>;
  source?: string;
  runId: string;
  agentId: string;
  createdAt: string;
}

export interface Identity { agentId: string; runId: string; }

export interface AddNodeInput {
  type: string;
  name: string;
  id?: string;
  body?: string;
  props?: Record<string, unknown>;
  source?: string;
  inference?: boolean;
  version?: string;
  rubric?: string;
  aliases?: string[];
}

export interface AddEdgeInput {
  type: string;
  from: string;
  to: string;
  props?: Record<string, unknown>;
  source?: string;
}

/** A write rejected by an invariant — the caller turns this into a helpful error. */
export class GraphInvariantError extends Error {}

type LogOp =
  | ({ op: 'node' } & GraphNode)
  | ({ op: 'edge' } & GraphEdge)
  | { op: 'supersede'; id: string; by: string; runId: string; agentId: string; ts: string };

/**
 * Legacy display slug — kept for backward-compatible id resolution of graphs
 * written before the canonical-key dedup landed. New entity ids use
 * {@link canonicalKey}. `slug("UsageService")` and `slug("usage-service")`
 * DIVERGE, which is exactly the bug canonicalKey fixes; slug survives only so
 * old `entity:usageservice`-style ids still resolve via the fallback path.
 */
function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

/**
 * Split a label into normalised word tokens: break camelCase / PascalCase and
 * acronym boundaries into words, lowercase, and split on any non-alphanumeric.
 * `"UsageService"` → `["usage","service"]`, `"usage-service"` → `["usage","service"]`,
 * `"HTTPServer v2"` → `["http","server","v2"]`.
 */
function tokenize(s: string): string[] {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // ACRONYMWord → ACRONYM Word
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Canonical dedup key for an entity name: a **sorted, de-duplicated token set**.
 * This collapses camelCase, kebab-case and spaced spellings AND word order to a
 * single key, so `UsageService`, `usage-service` and `usage service` map to one
 * `entity:` id. Sorting means `"Service Usage"` also collapses onto the same key.
 */
export function canonicalKey(s: string): string {
  const toks = Array.from(new Set(tokenize(s))).sort();
  return toks.join('-').slice(0, 60) || 'x';
}

function shortId(): string { return crypto.randomBytes(5).toString('hex'); }

/** Rough token estimate for budgeting — ~4 chars/token. */
export function estimateTokens(s: string): number {
  return Math.ceil((s ? s.length : 0) / 4);
}

// atomicity ceiling for a lock-free appendFileSync: writes at or below PIPE_BUF
// (4096 on Linux) can't interleave with a concurrent writer. We warn a little
// below it so a serialized op line that risks a torn interleave is never silent.
const PIPE_BUF_SAFE = 4000;

/**
 * Schema-guided edge ontology (Tier 0, item 6). For each relation, the allowed
 * `(sourceType → targetType)` shapes. `'*'` means "any node type". The goal is
 * to catch obvious mistakes (e.g. `evaluates: commit→task`), not to be a
 * straitjacket — most relations stay permissive.
 */
type OntologyRule = { from: '*' | GraphNodeType[]; to: '*' | GraphNodeType[] };
const EDGE_ONTOLOGY: Record<GraphEdgeType, OntologyRule[]> = {
  produced:     [{ from: ['agent_run'], to: ['artifact'] }],
  evaluates:    [{ from: ['evaluation'], to: ['artifact', 'agent_run'] }],
  supports:     [{ from: '*', to: ['claim'] }],
  contradicts:  [{ from: '*', to: ['claim'] }],
  resolved_to:  [{ from: '*', to: ['entity'] }],
  derived_from: [{ from: '*', to: '*' }],
  parent_of:    [{ from: '*', to: '*' }],
  depends_on:   [{ from: '*', to: '*' }],
  mentions:     [{ from: '*', to: '*' }],
  relates_to:   [{ from: '*', to: '*' }],
  revises:      [{ from: '*', to: '*' }],
  supersedes:   [{ from: '*', to: '*' }],
};

function describeRule(r: OntologyRule): string {
  const f = r.from === '*' ? '*' : r.from.join('|');
  const t = r.to === '*' ? '*' : r.to.join('|');
  return `(${f})→(${t})`;
}

/** @returns true if the triple is allowed, else a human-readable rejection reason. */
function edgeAllowed(rel: GraphEdgeType, fromType: GraphNodeType, toType: GraphNodeType): true | string {
  const rules = EDGE_ONTOLOGY[rel];
  if (!rules) { return true; } // unknown relation types are validated earlier; stay permissive here
  for (const r of rules) {
    const okFrom = r.from === '*' || r.from.includes(fromType);
    const okTo = r.to === '*' || r.to.includes(toType);
    if (okFrom && okTo) { return true; }
  }
  return `edge "${rel}" expects ${rules.map(describeRule).join(' or ')}, but got (${fromType})→(${toType})`;
}

export class GraphStore {
  private readonly dir: string;
  private readonly file: string;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  /** nodeId → incident edges (both directions). Rebuilt on clear, kept in step in apply(). */
  private adjacency = new Map<string, GraphEdge[]>();
  /** entity canonical-key → entity node id — the dedup + legacy-id resolution index. */
  private entityIndex = new Map<string, string>();

  private lastSize = -1;
  private lastMtimeMs = -1;
  /** byte offset up to (and including) the last COMPLETE log line we've applied. */
  private lastOffset = 0;
  /** total log ops applied since the last full rebuild (for dead-weight telemetry). */
  private appliedOps = 0;
  /** complete-but-corrupt (JSON-unparseable) MIDDLE lines seen; a torn FINAL line is NOT counted. */
  private parseFailures = 0;
  /** wall-clock ms of the last (incremental or full) reload. */
  private lastReplayMs = 0;

  constructor(workspaceRoot: string, private identity: Identity) {
    this.dir = path.join(workspaceRoot, '.autodev', 'graph');
    this.file = path.join(this.dir, 'graph.jsonl');
    this.reloadIfChanged();
  }

  /** Where the graph lives (for messages). */
  get path(): string { return this.file; }

  // ── persistence ──────────────────────────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) { fs.mkdirSync(this.dir, { recursive: true }); }
  }

  private clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.entityIndex.clear();
    this.appliedOps = 0;
    this.parseFailures = 0;
    this.lastOffset = 0;
  }

  /**
   * Re-materialise from disk when the log changed under us (another agent wrote).
   * INCREMENTAL: since the log is append-only we treat `lastOffset` as a byte
   * cursor and apply only the newly-appended tail on top of the live maps (apply
   * is idempotent). A full clear+rebuild happens only when the file shrank below
   * our cursor (a rewrite). A torn final line is left unconsumed and picked up on
   * a later tick once the writer finishes it. This is provably identical to a
   * full replay because apply() is last-writer-wins and the log is append-only.
   */
  reloadIfChanged(): void {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(this.file); } catch { st = null; }
    if (!st) {
      if (this.nodes.size || this.edges.size || this.lastOffset !== 0) { this.clear(); }
      this.lastSize = 0; this.lastMtimeMs = 0; this.lastOffset = 0;
      return;
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) { return; }
    const t0 = Date.now();
    if (st.size < this.lastOffset) {
      // the file was truncated/rewritten under us — rebuild from scratch.
      this.clear();
      this.replayRange(0, st.size);
    } else {
      // append-only growth — fold just the new tail onto the current state.
      this.replayRange(this.lastOffset, st.size);
    }
    this.lastReplayMs = Date.now() - t0;
    this.lastSize = st.size;
    this.lastMtimeMs = st.mtimeMs;
  }

  /** Read bytes [start,end), apply every COMPLETE line, and advance lastOffset past them. */
  private replayRange(start: number, end: number): void {
    if (end <= start) { this.lastOffset = end; return; }
    let buf: Buffer;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = end - start;
      const b = Buffer.allocUnsafe(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, b, read, len - read, start + read);
        if (n <= 0) { break; }
        read += n;
      }
      buf = read === len ? b : b.subarray(0, read);
    } finally { fs.closeSync(fd); }

    // Only apply up to the last newline; the trailing bytes (if any) are a torn
    // final line — leave the cursor before them so the next tick re-reads them.
    const lastNl = buf.lastIndexOf(0x0A);
    if (lastNl < 0) { return; } // no complete line yet
    const complete = buf.subarray(0, lastNl + 1).toString('utf8');
    for (const line of complete.split('\n')) {
      const t = line.trim();
      if (!t) { continue; }
      let op: LogOp;
      try { op = JSON.parse(t) as LogOp; }
      catch { this.parseFailures++; continue; } // a complete but corrupt MIDDLE line — surfaced in stats
      this.apply(op);
    }
    this.lastOffset = start + lastNl + 1;
  }

  private apply(op: LogOp): void {
    this.appliedOps++;
    if (op.op === 'node') {
      const { op: _o, ...node } = op;
      this.nodes.set(node.id, node as GraphNode);
      this.indexEntity(node as GraphNode);
    } else if (op.op === 'edge') {
      const { op: _o, ...edge } = op;
      const prev = this.edges.get(edge.id);
      if (prev) { this.unindexEdge(prev); }
      this.edges.set(edge.id, edge as GraphEdge);
      this.indexEdge(edge as GraphEdge);
    } else if (op.op === 'supersede') {
      const old = this.nodes.get(op.id);
      if (old) { old.supersededBy = op.by; old.updatedAt = op.ts; }
    }
  }

  private indexEntity(n: GraphNode): void {
    if (n.type !== 'entity') { return; }
    // name wins; aliases fill gaps so they can resolve the same entity.
    this.entityIndex.set(canonicalKey(n.name), n.id);
    for (const a of n.aliases || []) {
      const k = canonicalKey(a);
      if (!this.entityIndex.has(k)) { this.entityIndex.set(k, n.id); }
    }
  }

  private indexEdge(e: GraphEdge): void {
    this.pushAdj(e.from, e);
    if (e.to !== e.from) { this.pushAdj(e.to, e); }
  }
  private pushAdj(nid: string, e: GraphEdge): void {
    const list = this.adjacency.get(nid);
    if (list) { list.push(e); } else { this.adjacency.set(nid, [e]); }
  }
  private unindexEdge(e: GraphEdge): void {
    for (const nid of new Set([e.from, e.to])) {
      const list = this.adjacency.get(nid);
      if (!list) { continue; }
      const i = list.findIndex((x) => x.id === e.id);
      if (i >= 0) { list.splice(i, 1); }
    }
  }

  private append(op: LogOp): void {
    this.ensureDir();
    const line = JSON.stringify(op) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    // SAFETY (Tier 0, item 3): appendFileSync is only atomic below PIPE_BUF; a
    // larger line can interleave with a concurrent agent's append in this
    // lock-free model. Never silent — warn on stderr with a pointer to the cause.
    if (bytes > PIPE_BUF_SAFE) {
      const id = (op as { id?: string }).id ?? op.op;
      process.stderr.write(
        `[graph] warning: op ${id} serialises to ${bytes} bytes (> ${PIPE_BUF_SAFE}); ` +
        `appendFileSync is not atomic above PIPE_BUF and may interleave with a concurrent writer — ` +
        `consider shortening its body/props.\n`,
      );
    }
    fs.appendFileSync(this.file, line);
    this.apply(op);
    try {
      const st = fs.statSync(this.file);
      this.lastSize = st.size; this.lastMtimeMs = st.mtimeMs;
      this.lastOffset = st.size; // our own write is fully consumed
    } catch { /* stat best-effort */ }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  addNode(input: AddNodeInput): { node: GraphNode; created: boolean } {
    this.reloadIfChanged();
    const type = String(input.type || '').toLowerCase().trim() as GraphNodeType;
    if (!NODE_TYPES.includes(type)) {
      throw new GraphInvariantError(`unknown node type "${input.type}". Allowed: ${NODE_TYPES.join(', ')}`);
    }
    const name = String(input.name || '').trim();
    if (!name) { throw new GraphInvariantError('node "name" is required'); }

    // Invariant 1 — a claim must be sourced or explicitly an inference.
    if (type === 'claim' && !input.source && input.inference !== true) {
      throw new GraphInvariantError('a "claim" needs a source (pass source:"file:line"/url/source-node-id) or inference:true');
    }
    // Invariant 2 — an artifact must carry a version (its run is auto-attached).
    if (type === 'artifact' && !String(input.version || '').trim()) {
      throw new GraphInvariantError('an "artifact" needs a version (pass version:"1.4.93" / a commit sha / a semver)');
    }
    // Invariant 3 — an evaluation must name the rubric it judged against.
    if (type === 'evaluation' && !String(input.rubric || '').trim()) {
      throw new GraphInvariantError('an "evaluation" needs a rubric (pass rubric:"what criteria were checked")');
    }

    // Stable ids: entities dedupe by a sorted-token-set canonical key so
    // UsageService / usage-service / "usage service" resolve to ONE id — and old
    // graphs stay addressable because the key index is seeded from stored names.
    // Everything else gets a fresh id unless the caller pins one (upsert).
    const id = String(input.id || '').trim() || this.mintId(type, name, input.aliases);
    const now = new Date().toISOString();
    const existing = this.nodes.get(id);

    const node: GraphNode = {
      id, type, name,
      body: input.body ?? existing?.body,
      props: input.props ?? existing?.props,
      source: input.source ?? existing?.source,
      inference: input.inference ?? existing?.inference,
      version: input.version ?? existing?.version,
      rubric: input.rubric ?? existing?.rubric,
      aliases: mergeAliases(existing?.aliases, input.aliases, existing?.name, name),
      supersededBy: existing?.supersededBy,
      runId: this.identity.runId,
      agentId: this.identity.agentId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.append({ op: 'node', ...node });
    return { node, created: !existing };
  }

  /** Deterministic id for a new node: entities dedupe by canonical key (+ aliases), others are fresh. */
  private mintId(type: GraphNodeType, name: string, aliases?: string[]): string {
    if (type !== 'entity') { return `${type}:${shortId()}`; }
    const key = canonicalKey(name);
    let existingId = this.entityIndex.get(key);
    if (!existingId) {
      for (const a of aliases || []) {
        const hit = this.entityIndex.get(canonicalKey(a));
        if (hit) { existingId = hit; break; }
      }
    }
    return existingId || `entity:${key}`;
  }

  addEdge(input: AddEdgeInput): GraphEdge {
    this.reloadIfChanged();
    const type = String(input.type || '').toLowerCase().trim() as GraphEdgeType;
    if (!EDGE_TYPES.includes(type)) {
      throw new GraphInvariantError(`unknown edge type "${input.type}". Allowed: ${EDGE_TYPES.join(', ')}`);
    }
    const from = String(input.from || '').trim();
    const to = String(input.to || '').trim();
    if (!from || !to) { throw new GraphInvariantError('edge needs both "from" and "to" node ids'); }
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);
    if (!fromNode) { throw new GraphInvariantError(`edge "from" node not found: ${from}`); }
    if (!toNode) { throw new GraphInvariantError(`edge "to" node not found: ${to}`); }

    // SAFETY (Tier 0, item 6): reject an obviously-wrong (fromType, relation,
    // targetType) triple — e.g. evaluates: commit→task — with a helpful message.
    const verdict = edgeAllowed(type, fromNode.type, toNode.type);
    if (verdict !== true) { throw new GraphInvariantError(verdict); }

    const edge: GraphEdge = {
      id: `edge:${shortId()}`, type, from, to,
      props: input.props, source: input.source,
      runId: this.identity.runId, agentId: this.identity.agentId,
      createdAt: new Date().toISOString(),
    };
    this.append({ op: 'edge', ...edge });
    return edge;
  }

  /**
   * Version a node: create the replacement, link it with a `supersedes` edge,
   * and flag the old node `supersededBy`. The old node stays addressable
   * (invariant 4) — it just drops out of default query results.
   */
  supersede(oldId: string, replacement: AddNodeInput): { oldId: string; node: GraphNode; edge: GraphEdge } {
    this.reloadIfChanged();
    const old = this.nodes.get(oldId);
    if (!old) { throw new GraphInvariantError(`supersede: node not found: ${oldId}`); }
    const { node } = this.addNode({ ...replacement, type: old.type });
    const edge = this.addEdge({ type: 'supersedes', from: node.id, to: oldId });
    this.append({ op: 'supersede', id: oldId, by: node.id, runId: this.identity.runId, agentId: this.identity.agentId, ts: new Date().toISOString() });
    return { oldId, node, edge };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  getNode(idOrName: string): GraphNode | undefined {
    this.reloadIfChanged();
    if (!idOrName) { return undefined; }
    if (this.nodes.has(idOrName)) { return this.nodes.get(idOrName); }
    const needle = idOrName.toLowerCase();
    // exact name match first, then alias, then the entity canonical-key index,
    // then the legacy slug convention (so pre-canonical graphs still resolve).
    for (const n of this.nodes.values()) { if (n.name.toLowerCase() === needle) { return n; } }
    for (const n of this.nodes.values()) { if ((n.aliases || []).some((a) => a.toLowerCase() === needle)) { return n; } }
    const eid = this.entityIndex.get(canonicalKey(idOrName));
    if (eid && this.nodes.has(eid)) { return this.nodes.get(eid); }
    return this.nodes.get(`entity:${slug(idOrName)}`);
  }

  /** Incident `contradicts` edges of a node, resolved to {id,name} of the other endpoint. */
  contradictionsFor(id: string): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    for (const e of this.adjacency.get(id) || []) {
      if (e.type !== 'contradicts') { continue; }
      const otherId = e.from === id ? e.to : e.from;
      out.push({ id: otherId, name: this.nodes.get(otherId)?.name ?? otherId });
    }
    return out;
  }

  /** Node degree (incident edge count) — shared ranking infra for Tier 1. */
  degree(id: string): number {
    return (this.adjacency.get(id) || []).length;
  }

  query(opts: { type?: string; text?: string; id?: string; includeSuperseded?: boolean; limit?: number }): GraphNode[] {
    this.reloadIfChanged();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const type = opts.type ? String(opts.type).toLowerCase() : undefined;
    const text = opts.text ? String(opts.text).toLowerCase() : undefined;
    const out: GraphNode[] = [];
    for (const n of this.nodes.values()) {
      if (opts.id && n.id !== opts.id) { continue; }
      if (type && n.type !== type) { continue; }
      if (!opts.includeSuperseded && n.supersededBy) { continue; }
      if (text) {
        const hay = `${n.name}\n${n.body ?? ''}\n${(n.aliases || []).join(' ')}`.toLowerCase();
        if (!hay.includes(text)) { continue; }
      }
      out.push(n);
    }
    // freshest first — recent verified facts are the most useful context
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out.slice(0, limit);
  }

  /**
   * Bounded neighbourhood around a node — the playbook's "context construction
   * from a graph": resolve the entity, expand a hop or two over allowed edge
   * types, and return a small, citable subgraph rather than the whole graph.
   * Uses the adjacency index (O(visited degree), not O(E·hops)) and returns the
   * BFS hop-distance per node so the caller can rank/token-budget the result.
   * `includeConflicts` (default true) always follows `contradicts` edges so a
   * conflicting claim can never be hidden by an `edgeTypes` filter.
   */
  neighbors(opts: { idOrName: string; hops?: number; edgeTypes?: string[]; limit?: number; includeConflicts?: boolean }):
    { center: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; dist: Record<string, number> } | null {
    this.reloadIfChanged();
    const center = this.getNode(opts.idOrName);
    if (!center) { return null; }
    const hops = Math.max(1, Math.min(3, opts.hops ?? 1));
    const edgeLimit = Math.max(1, Math.min(200, opts.limit ?? 40));
    const allow: Set<string> | null = opts.edgeTypes && opts.edgeTypes.length
      ? new Set(opts.edgeTypes.map((e) => e.toLowerCase())) : null;
    if (allow && opts.includeConflicts !== false) { allow.add('contradicts'); }

    const dist = new Map<string, number>([[center.id, 0]]);
    const nodeOut = new Map<string, GraphNode>([[center.id, center]]);
    const edgeOut: GraphEdge[] = [];
    const edgeSeen = new Set<string>();
    let frontier = [center.id];
    for (let h = 0; h < hops && edgeOut.length < edgeLimit; h++) {
      const next: string[] = [];
      for (const nid of frontier) {
        for (const e of this.adjacency.get(nid) || []) {
          if (allow && !allow.has(e.type)) { continue; }
          if (!edgeSeen.has(e.id)) {
            edgeSeen.add(e.id);
            edgeOut.push(e);
            if (edgeOut.length >= edgeLimit) { break; }
          }
          const other = e.from === nid ? e.to : e.from;
          if (!nodeOut.has(other)) {
            const nn = this.nodes.get(other);
            if (nn) { nodeOut.set(other, nn); dist.set(other, h + 1); next.push(other); }
          }
        }
        if (edgeOut.length >= edgeLimit) { break; }
      }
      frontier = next;
      if (!frontier.length) { break; }
    }
    return { center, nodes: [...nodeOut.values()], edges: edgeOut, dist: Object.fromEntries(dist) };
  }

  stats(): {
    nodeCount: number; edgeCount: number;
    nodesByType: Record<string, number>; edgesByType: Record<string, number>;
    superseded: number; isolated: number; contradictions: number; openQuestions: number;
    // Tier 0 telemetry (item 8)
    fileBytes: number; totalOps: number; deadWeight: number; deadWeightRatio: number;
    lastReplayMs: number; estTokens: number; parseFailures: number; tornFinalLine: boolean;
  } {
    this.reloadIfChanged();
    const nodesByType: Record<string, number> = {};
    const edgesByType: Record<string, number> = {};
    let superseded = 0, openQuestions = 0, estTokens = 0;
    for (const e of this.edges.values()) {
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
      estTokens += estimateTokens(`${e.type}${e.from}${e.to}${e.source ?? ''}`);
    }
    let isolated = 0;
    for (const n of this.nodes.values()) {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
      if (n.supersededBy) { superseded++; }
      if (n.type === 'question' && !n.supersededBy) { openQuestions++; }
      if (this.degree(n.id) === 0 && !n.supersededBy) { isolated++; }
      estTokens += estimateTokens(`${n.name}${n.body ?? ''}`);
    }
    const contradictions = edgesByType['contradicts'] || 0;
    const live = this.nodes.size + this.edges.size;
    const deadWeight = Math.max(0, this.appliedOps - live);
    return {
      nodeCount: this.nodes.size, edgeCount: this.edges.size,
      nodesByType, edgesByType, superseded, isolated, contradictions, openQuestions,
      fileBytes: this.lastSize < 0 ? 0 : this.lastSize,
      totalOps: this.appliedOps,
      deadWeight,
      deadWeightRatio: this.appliedOps ? deadWeight / this.appliedOps : 0,
      lastReplayMs: this.lastReplayMs,
      estTokens,
      parseFailures: this.parseFailures,
      tornFinalLine: this.lastOffset < this.lastSize,
    };
  }
}

function mergeAliases(prev: string[] | undefined, add: string[] | undefined, prevName?: string, newName?: string): string[] | undefined {
  const set = new Set<string>(prev || []);
  for (const a of add || []) { if (a && a.trim()) { set.add(a.trim()); } }
  // if a node is re-added under a different display name, keep the old name as an alias
  if (prevName && newName && prevName !== newName) { set.add(prevName); }
  const arr = [...set];
  return arr.length ? arr : undefined;
}
