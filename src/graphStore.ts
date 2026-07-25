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

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}
function shortId(): string { return crypto.randomBytes(5).toString('hex'); }

export class GraphStore {
  private readonly dir: string;
  private readonly file: string;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private lastSize = -1;
  private lastMtimeMs = -1;

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

  /** Re-materialise from disk when the log changed under us (another agent wrote). */
  reloadIfChanged(): void {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(this.file); } catch { st = null; }
    if (!st) {
      if (this.lastSize !== 0) { this.nodes.clear(); this.edges.clear(); this.lastSize = 0; this.lastMtimeMs = 0; }
      return;
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) { return; }
    this.nodes.clear();
    this.edges.clear();
    const text = fs.readFileSync(this.file, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) { continue; }
      let op: LogOp;
      try { op = JSON.parse(t) as LogOp; } catch { continue; } // tolerate a torn final line
      this.apply(op);
    }
    this.lastSize = st.size;
    this.lastMtimeMs = st.mtimeMs;
  }

  private apply(op: LogOp): void {
    if (op.op === 'node') {
      const { op: _o, ...node } = op;
      this.nodes.set(node.id, node as GraphNode);
    } else if (op.op === 'edge') {
      const { op: _o, ...edge } = op;
      this.edges.set(edge.id, edge as GraphEdge);
    } else if (op.op === 'supersede') {
      const old = this.nodes.get(op.id);
      if (old) { old.supersededBy = op.by; old.updatedAt = op.ts; }
    }
  }

  private append(op: LogOp): void {
    this.ensureDir();
    fs.appendFileSync(this.file, JSON.stringify(op) + '\n');
    try {
      const st = fs.statSync(this.file);
      this.lastSize = st.size; this.lastMtimeMs = st.mtimeMs;
    } catch { /* stat best-effort */ }
    this.apply(op);
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

    // Stable ids: entities dedupe by normalised name so resolution is idempotent;
    // everything else gets a fresh id unless the caller pins one (upsert).
    const id = String(input.id || '').trim()
      || (type === 'entity' ? `entity:${slug(name)}` : `${type}:${shortId()}`);
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

  addEdge(input: AddEdgeInput): GraphEdge {
    this.reloadIfChanged();
    const type = String(input.type || '').toLowerCase().trim() as GraphEdgeType;
    if (!EDGE_TYPES.includes(type)) {
      throw new GraphInvariantError(`unknown edge type "${input.type}". Allowed: ${EDGE_TYPES.join(', ')}`);
    }
    const from = String(input.from || '').trim();
    const to = String(input.to || '').trim();
    if (!from || !to) { throw new GraphInvariantError('edge needs both "from" and "to" node ids'); }
    if (!this.nodes.has(from)) { throw new GraphInvariantError(`edge "from" node not found: ${from}`); }
    if (!this.nodes.has(to)) { throw new GraphInvariantError(`edge "to" node not found: ${to}`); }
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
    // exact name match first, then alias, then the entity-slug convention
    for (const n of this.nodes.values()) { if (n.name.toLowerCase() === needle) { return n; } }
    for (const n of this.nodes.values()) { if ((n.aliases || []).some(a => a.toLowerCase() === needle)) { return n; } }
    return this.nodes.get(`entity:${slug(idOrName)}`);
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
   */
  neighbors(opts: { idOrName: string; hops?: number; edgeTypes?: string[]; limit?: number }):
    { center: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } | null {
    this.reloadIfChanged();
    const center = this.getNode(opts.idOrName);
    if (!center) { return null; }
    const hops = Math.max(1, Math.min(3, opts.hops ?? 1));
    const edgeLimit = Math.max(1, Math.min(200, opts.limit ?? 40));
    const allow = opts.edgeTypes && opts.edgeTypes.length
      ? new Set(opts.edgeTypes.map(e => e.toLowerCase())) : null;

    const seen = new Set<string>([center.id]);
    const nodeOut = new Map<string, GraphNode>([[center.id, center]]);
    const edgeOut: GraphEdge[] = [];
    let frontier = [center.id];
    for (let h = 0; h < hops && edgeOut.length < edgeLimit; h++) {
      const next: string[] = [];
      for (const e of this.edges.values()) {
        if (allow && !allow.has(e.type)) { continue; }
        const touchesFrontier = frontier.includes(e.from) || frontier.includes(e.to);
        if (!touchesFrontier) { continue; }
        if (!edgeOut.find(x => x.id === e.id)) {
          edgeOut.push(e);
          if (edgeOut.length >= edgeLimit) { break; }
        }
        for (const nid of [e.from, e.to]) {
          if (!seen.has(nid)) {
            seen.add(nid);
            const nn = this.nodes.get(nid);
            if (nn) { nodeOut.set(nid, nn); next.push(nid); }
          }
        }
      }
      frontier = next;
      if (!frontier.length) { break; }
    }
    return { center, nodes: [...nodeOut.values()], edges: edgeOut };
  }

  stats(): {
    nodeCount: number; edgeCount: number;
    nodesByType: Record<string, number>; edgesByType: Record<string, number>;
    superseded: number; isolated: number; contradictions: number; openQuestions: number;
  } {
    this.reloadIfChanged();
    const nodesByType: Record<string, number> = {};
    const edgesByType: Record<string, number> = {};
    let superseded = 0, openQuestions = 0;
    const touched = new Set<string>();
    for (const e of this.edges.values()) {
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
      touched.add(e.from); touched.add(e.to);
    }
    let isolated = 0;
    for (const n of this.nodes.values()) {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
      if (n.supersededBy) { superseded++; }
      if (n.type === 'question' && !n.supersededBy) { openQuestions++; }
      if (!touched.has(n.id) && !n.supersededBy) { isolated++; }
    }
    const contradictions = edgesByType['contradicts'] || 0;
    return {
      nodeCount: this.nodes.size, edgeCount: this.edges.size,
      nodesByType, edgesByType, superseded, isolated, contradictions, openQuestions,
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
