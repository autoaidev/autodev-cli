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
  /**
   * A one-line gist of the node — the navigation enabler (Tier 1, item 3).
   * Agent-supplied at write (the writing agent already holds the context, and it
   * rides its provenance like any write). Optional and purely additive: old log
   * lines without `summary` replay fine. When absent on an interior/hub node, a
   * deterministic structural rollup is synthesized on read (no LLM call).
   */
  summary?: string;
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
  /** One-line gist (Tier 1). Stamped with a `summaryAt` prop so staleness is detectable. */
  summary?: string;
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
export function tokenize(s: string): string[] {
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

// ── Tier 2 constants ─────────────────────────────────────────────────────────
/** Node types whose `file:line` source triggers the parent_of auto-scaffold (item 1). */
const SCAFFOLD_SOURCE_TYPES = new Set<GraphNodeType>(['claim', 'artifact', 'decision', 'note']);
/** Regenerate the materialised snapshot when the uncovered JSONL tail exceeds this many bytes. */
const SNAPSHOT_TAIL_BYTES = 256 * 1024;
/** …or this many ops applied since the last snapshot (item 3). */
const SNAPSHOT_TAIL_OPS = 2000;

/**
 * Parse a `file:line`-style source into its cumulative path segments — the spine
 * an auto-scaffold builds (item 1). `"src/foo/bar.ts:12"` → `["src","src/foo",
 * "src/foo/bar.ts"]`; `"pay.ts:10"` → `["pay.ts"]`. Returns null for a URL, a
 * source-node id (`source:ab12`), or anything that doesn't look like a path — the
 * scaffold is deterministic and conservative, never a guess.
 */
export function parseSourcePath(source: string | undefined): string[] | null {
  let s = String(source || '').trim();
  if (!s) { return null; }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { return null; }   // url (http://, file://, …)
  s = s.replace(/:\d+(:\d+)?$/, '');                          // strip :line(:col)
  s = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || s.includes('..')) { return null; }
  // must look like a file path: has a '/' or a dotted extension (rules out `source:ab12`)
  const looksPath = s.includes('/') || /\.[a-z0-9]+$/i.test(s);
  if (!looksPath) { return null; }
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.length > 20) { return null; }
  const cumulative: string[] = [];
  let acc = '';
  for (const p of parts) { acc = acc ? `${acc}/${p}` : p; cumulative.push(acc); }
  return cumulative;
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

// ── Relevance ranking (Tier 1, item 1) ──────────────────────────────────────
// A deliberately VECTORLESS scorer: field-weighted TF·IDF over the resident node
// set, lifted by recency + degree. Honours PageIndex's "similarity ≠ relevance" —
// no embeddings, fully explainable. Field weights: name > summary ≈ aliases > body.
const FIELD_WEIGHTS: { field: 'name' | 'summary' | 'aliases' | 'body'; weight: number }[] = [
  { field: 'name', weight: 3 },
  { field: 'summary', weight: 2 },
  { field: 'aliases', weight: 2 },
  { field: 'body', weight: 1 },
];
/** Weight of the recency lift in finalScore = textScore·(1 + wRecency·decay + wDegree·log1p(deg)). */
const W_RECENCY = 0.5;
/** Weight of the connectivity (degree) lift. */
const W_DEGREE = 0.3;
/** Recency half-life-ish constant in days: exp(-ageDays/RECENCY_TAU). */
const RECENCY_TAU_DAYS = 30;
/** Guaranteed-inclusion floor for an exact-substring hit that scored 0 on tokens
 *  (keeps the old substring behaviour a strict subset of ranked results). */
const SUBSTR_FLOOR = 0.001;

/** Provenance strength for best-first expansion: strong provenance edges outrank weak ones. */
const EDGE_STRENGTH: Record<string, number> = {
  supports: 3, derived_from: 3, produced: 3, evaluates: 3, depends_on: 3, parent_of: 3,
  supersedes: 2, revises: 2, resolved_to: 2, contradicts: 2,
  mentions: 1, relates_to: 1,
};

/** A scored query row (Tier 1) — reused by graph_query, graph_map and graph_search. */
export interface ScoredNode { node: GraphNode; score: number; textScore: number; matched: string[]; substring: boolean; }

/** One "where do I start" map entry: a node plus its effective (authored or synthesized) summary. */
export interface MapEntry {
  id: string; type: GraphNodeType; name: string;
  summary?: string; synthesized?: boolean; stale?: boolean; degree: number;
}
export interface GraphMap {
  /** Pinned "core" tier (item 4): project invariants always prepended within budget. */
  pinned: MapEntry[];
  hubs: MapEntry[];
  questions: MapEntry[];
  decisions: MapEntry[];
  contradictions: { a: { id: string; name: string }; b: { id: string; name: string } }[];
}

/** One node of a navigable table-of-contents (item 2). */
export interface TocNode {
  id: string;
  type: string;
  name: string;
  summary?: string;
  synthesized?: boolean;
  /** Total parent_of children (before the maxChildren cap). */
  childCount: number;
  children: TocNode[];
  /** Children collapsed by the maxChildren cap or depth bound — the "+K more". */
  moreChildren?: number;
}
export interface TocResult {
  roots: TocNode[];
  /** True when the spine was sparse and roots fell back to deterministic clustering. */
  clustered?: boolean;
}

/** One row of a graph_search bundle — citable, with the edge-path from its seed. */
export interface SearchRow {
  id: string; type: GraphNodeType; name: string;
  score: number; matched: string[];
  summary?: string; synthesized?: boolean;
  inference?: boolean;
  seedId: string;
  /** The edge used to reach this node (undefined for a seed). */
  via?: { edge: GraphEdgeType; fromId: string; dir: 'out' | 'in' };
  /** Hop descriptors from the seed, e.g. ["supports→ claim:ab12"] — for explainability. */
  path: string[];
  conflicts: { id: string; name: string }[];
}
export interface SearchResult { intent: string; terms: string[]; budget: number; hops: number; rows: SearchRow[]; }

export class GraphStore {
  private readonly dir: string;
  private readonly file: string;
  /** Disposable materialised cache for cold-start (item 3). JSONL stays the sole source of truth. */
  private readonly snapshotFile: string;
  private readonly snapshotEnabled: boolean;
  /** Byte offset the on-disk snapshot covers (0 = none loaded/written this session). */
  private snapshotCoversBytes = 0;
  /** Ops applied since the last snapshot was written/loaded — the regeneration trigger. */
  private opsSinceSnapshot = 0;
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
  /** Monotonic node-set version bumped by apply() — the invalidation signal reload uses. */
  private mutationSeq = 0;
  /** IDF over the resident node set, memoised until mutationSeq changes (item 1). */
  private idfCache: Map<string, number> | null = null;
  private idfCacheSeq = -1;

  constructor(workspaceRoot: string, private identity: Identity, opts?: { snapshot?: boolean }) {
    this.dir = path.join(workspaceRoot, '.autodev', 'graph');
    this.file = path.join(this.dir, 'graph.jsonl');
    this.snapshotFile = path.join(this.dir, 'graph.snapshot.json');
    // Snapshot is on by default; pass { snapshot: false } for a pure full-replay store
    // (used by tests to prove snapshot+tail == full replay).
    this.snapshotEnabled = opts?.snapshot !== false;
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
    this.idfCache = null;
    this.snapshotCoversBytes = 0;
    this.opsSinceSnapshot = 0;
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
    const firstLoad = this.lastSize < 0;
    if (st.size < this.lastOffset) {
      // the file was truncated/rewritten under us — rebuild from scratch.
      this.clear();
      this.loadFromScratch(st.size);
    } else if (firstLoad) {
      // cold start — try the materialised snapshot, else full replay.
      this.loadFromScratch(st.size);
    } else {
      // append-only growth — fold just the new tail onto the current state.
      this.replayRange(this.lastOffset, st.size);
    }
    this.lastReplayMs = Date.now() - t0;
    this.lastSize = st.size;
    this.lastMtimeMs = st.mtimeMs;
    if (this.snapshotEnabled) { this.maybeWriteSnapshot(st.size); }
  }

  // ── materialised snapshot (Tier 2, item 3) ─────────────────────────────────

  /**
   * Cold-start load: if a valid snapshot covers a prefix of the current log, adopt
   * it and tail-replay only the uncovered bytes; otherwise full-replay. The
   * snapshot is a DISPOSABLE cache — a missing / stale / corrupt one simply falls
   * back to full replay, and the JSONL is never touched.
   */
  private loadFromScratch(size: number): void {
    if (this.snapshotEnabled && this.tryLoadSnapshot(size)) {
      this.replayRange(this.lastOffset, size); // fold the tail beyond the snapshot
      return;
    }
    this.clear();
    this.replayRange(0, size);
  }

  /** sha256 of the first min(4096, covers) bytes of the log — the cheap rewrite guard. */
  private headSig(covers: number): string {
    const n = Math.min(4096, covers);
    const fd = fs.openSync(this.file, 'r');
    try {
      const b = Buffer.allocUnsafe(n);
      let read = 0;
      while (read < n) { const k = fs.readSync(fd, b, read, n - read, read); if (k <= 0) { break; } read += k; }
      return crypto.createHash('sha256').update(b.subarray(0, read)).digest('hex');
    } finally { fs.closeSync(fd); }
  }

  /**
   * Adopt the on-disk snapshot iff it is a valid prefix of the current log:
   * `coversBytes` in (0, size] AND the head-signature still matches (guards against
   * a rewritten/truncated log whose prefix changed). Rebuilds the derived indexes
   * from the resident node/edge set rather than trusting serialized indexes.
   */
  private tryLoadSnapshot(size: number): boolean {
    try {
      if (!fs.existsSync(this.snapshotFile)) { return false; }
      const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8')) as {
        coversBytes?: unknown; headSig?: unknown; nodes?: unknown; edges?: unknown;
      };
      const covers = Number(snap.coversBytes);
      if (!Number.isFinite(covers) || covers <= 0 || covers > size) { return false; }
      if (!Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) { return false; }
      if (typeof snap.headSig !== 'string' || this.headSig(covers) !== snap.headSig) { return false; }
      // valid → adopt. Populate the maps and rebuild adjacency + entity indexes.
      this.clear();
      for (const n of snap.nodes as GraphNode[]) { this.nodes.set(n.id, n); this.indexEntity(n); }
      for (const e of snap.edges as GraphEdge[]) { this.edges.set(e.id, e); this.indexEdge(e); }
      this.appliedOps = this.nodes.size + this.edges.size;
      this.mutationSeq++;
      this.idfCache = null;
      this.lastOffset = covers;
      this.snapshotCoversBytes = covers;
      this.opsSinceSnapshot = 0;
      return true;
    } catch { return false; }
  }

  /** Regenerate the snapshot when the uncovered tail grew past the byte/op threshold. */
  private maybeWriteSnapshot(size: number): void {
    const uncoveredBytes = size - this.snapshotCoversBytes;
    if (uncoveredBytes >= SNAPSHOT_TAIL_BYTES || this.opsSinceSnapshot >= SNAPSHOT_TAIL_OPS) {
      this.writeSnapshot();
    }
  }

  /**
   * Write the snapshot atomically (temp file + rename) so a partial write is never
   * visible and concurrent multi-agent regenerations can't corrupt it — the loser
   * of a rename race simply leaves a consistent, self-describing file behind. Snaps
   * only the byte prefix we've fully applied (`lastOffset`), so a torn final line is
   * never captured.
   */
  private writeSnapshot(): boolean {
    const covers = this.lastOffset;
    if (covers <= 0) { return false; }
    try {
      this.ensureDir();
      const snap = {
        coversBytes: covers,
        generatedAt: new Date().toISOString(),
        generatedBy: this.identity.agentId,
        headSig: this.headSig(covers),
        nodes: [...this.nodes.values()],
        edges: [...this.edges.values()],
      };
      const tmp = `${this.snapshotFile}.${process.pid}.${shortId()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, this.snapshotFile);
      this.snapshotCoversBytes = covers;
      this.opsSinceSnapshot = 0;
      return true;
    } catch { return false; }
  }

  /** Force a snapshot now (test hook / explicit checkpoint). No-op when snapshots are disabled. */
  materializeSnapshot(): boolean {
    this.reloadIfChanged();
    return this.snapshotEnabled ? this.writeSnapshot() : false;
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
    this.opsSinceSnapshot++;
    this.mutationSeq++; // invalidates the IDF cache (same signal reload rides)
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
    return this.addNodeInternal(input, { scaffold: true });
  }

  /**
   * The write path. `scaffold:true` (the public {@link addNode}) additionally runs
   * the deterministic parent_of auto-scaffold (item 1); the scaffold's own entity
   * writes pass `scaffold:false` so they never recurse.
   */
  private addNodeInternal(input: AddNodeInput, opts: { scaffold: boolean }): { node: GraphNode; created: boolean } {
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

    // Stamp when the summary was (re)written so staleness — gaining children or being
    // superseded AFTER the summary — is detectable without a separate op format.
    const summaryProvided = input.summary != null && String(input.summary).trim() !== '';
    let props = input.props ?? existing?.props;
    if (summaryProvided) { props = { ...(props || {}), summaryAt: now }; }

    const node: GraphNode = {
      id, type, name,
      body: input.body ?? existing?.body,
      summary: summaryProvided ? String(input.summary).trim() : existing?.summary,
      props,
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
    if (opts.scaffold) { this.scaffold(node); }
    return { node, created: !existing };
  }

  // ── parent_of auto-scaffold from source paths / area tags (Tier 2, item 1) ──

  /**
   * Deterministically fill the parent_of tree from a fact's provenance — NO LLM.
   * A `file:line` source on a claim/artifact/decision/note upserts `entity` nodes
   * for the file and its ancestor dirs and links a `dir → file → fact` spine; a
   * `props.area` tag upserts an area entity and parents the fact under it. Every
   * derived node/edge carries this run's provenance and a `props.autoScaffold=true`
   * marker, and is idempotent (deterministic ids + edge dedup) so re-adds and
   * concurrent writers converge instead of duplicating.
   */
  private scaffold(node: GraphNode): void {
    try {
      if (SCAFFOLD_SOURCE_TYPES.has(node.type) && node.source) { this.scaffoldFromSource(node); }
      const area = node.props?.area;
      if (typeof area === 'string' && area.trim()) { this.scaffoldFromArea(node, area.trim()); }
    } catch { /* scaffolding is best-effort — it must never fail the primary write */ }
  }

  private scaffoldFromSource(node: GraphNode): void {
    const segs = parseSourcePath(node.source);
    if (!segs || !segs.length) { return; }
    let prevId: string | null = null;
    for (let i = 0; i < segs.length; i++) {
      const p = segs[i];
      const isFile = i === segs.length - 1;
      const id = `entity:path:${p}`;
      this.addNodeInternal(
        { type: 'entity', name: p, id, props: { autoScaffold: true, kind: isFile ? 'file' : 'dir', path: p } },
        { scaffold: false },
      );
      if (prevId) { this.linkParentOf(prevId, id, node.source); }
      prevId = id;
    }
    if (prevId) { this.linkParentOf(prevId, node.id, node.source); }
  }

  private scaffoldFromArea(node: GraphNode, area: string): void {
    const id = `entity:area:${slug(area)}`;
    this.addNodeInternal(
      { type: 'entity', name: area, id, props: { autoScaffold: true, kind: 'area', area } },
      { scaffold: false },
    );
    this.linkParentOf(id, node.id);
  }

  /** Is there already an edge of `type` from→to? (idempotency for scaffold/rollup edges). */
  private hasEdge(type: string, from: string, to: string): boolean {
    for (const e of this.adjacency.get(from) || []) {
      if (e.type === type && e.from === from && e.to === to) { return true; }
    }
    return false;
  }

  /** Add a parent_of edge (marked autoScaffold) unless it already exists. */
  private linkParentOf(from: string, to: string, source?: string): void {
    if (from === to || this.hasEdge('parent_of', from, to)) { return; }
    this.addEdge({ type: 'parent_of', from, to, source, props: { autoScaffold: true } });
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

  // ── relevance ranking (Tier 1, item 1) ────────────────────────────────────

  /** IDF over the resident node set, memoised until the node set mutates. */
  private idf(): Map<string, number> {
    if (this.idfCache && this.idfCacheSeq === this.mutationSeq) { return this.idfCache; }
    const df = new Map<string, number>();
    const N = this.nodes.size || 1;
    for (const n of this.nodes.values()) {
      const toks = new Set<string>([
        ...tokenize(n.name),
        ...tokenize(n.summary || ''),
        ...tokenize((n.aliases || []).join(' ')),
        ...tokenize(n.body || ''),
      ]);
      for (const t of toks) { df.set(t, (df.get(t) || 0) + 1); }
    }
    const idf = new Map<string, number>();
    for (const [t, d] of df) { idf.set(t, Math.log(1 + N / (1 + d))); }
    this.idfCache = idf;
    this.idfCacheSeq = this.mutationSeq;
    return idf;
  }

  /** Exponential recency lift in [0,1]: 1 at now, decaying with age (τ≈30d). */
  private recencyDecay(ts: string | undefined): number {
    const ms = Date.parse(ts || '');
    if (!isFinite(ms)) { return 0; }
    const days = Math.max(0, (Date.now() - ms) / 86400000);
    return Math.exp(-days / RECENCY_TAU_DAYS);
  }

  /** Field-weighted TF·IDF text score for a node against a set of query terms. */
  private scoreNode(n: GraphNode, terms: string[], idf: Map<string, number>): { score: number; matched: string[] } {
    if (!terms.length) { return { score: 0, matched: [] }; }
    const fieldTokens: Record<string, string[]> = {
      name: tokenize(n.name),
      summary: tokenize(n.summary || ''),
      aliases: tokenize((n.aliases || []).join(' ')),
      body: tokenize(n.body || ''),
    };
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      let tf = 0;
      for (const { field, weight } of FIELD_WEIGHTS) {
        for (const tok of fieldTokens[field]) { if (tok === term) { tf += weight; } }
      }
      if (tf > 0) { score += tf * (idf.get(term) || 0); matched.push(term); }
    }
    return { score, matched };
  }

  /**
   * Relevance-ranked query (Tier 1, item 1). OR-semantics: a node is a hit if it
   * matches ≥1 query term OR contains the intent as an exact substring (the old
   * behaviour, kept as a guaranteed-inclusion signal → strict superset). Ranked by
   * `textScore·(1 + wRecency·decay + wDegree·log1p(degree))`. `mode:'recent'` keeps
   * the pure recency order; superseded nodes hidden unless includeSuperseded.
   */
  scoredQuery(opts: { type?: string; text?: string; id?: string; includeSuperseded?: boolean; limit?: number; mode?: 'relevance' | 'recent' }): ScoredNode[] {
    this.reloadIfChanged();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const type = opts.type ? String(opts.type).toLowerCase() : undefined;
    const text = opts.text ? String(opts.text) : undefined;
    const textLower = text ? text.toLowerCase() : undefined;
    const terms = text ? Array.from(new Set(tokenize(text))) : [];
    const idf = terms.length ? this.idf() : null;
    const mode = opts.mode ?? 'relevance';

    const rows: ScoredNode[] = [];
    for (const n of this.nodes.values()) {
      if (opts.id && n.id !== opts.id) { continue; }
      if (type && n.type !== type) { continue; }
      if (!opts.includeSuperseded && n.supersededBy) { continue; }
      if (textLower) {
        const { score: ts, matched } = this.scoreNode(n, terms, idf as Map<string, number>);
        const hay = `${n.name}\n${n.summary ?? ''}\n${n.body ?? ''}\n${(n.aliases || []).join(' ')}`.toLowerCase();
        const substring = hay.includes(textLower);
        let textScore = ts;
        if (substring && textScore <= 0) { textScore = SUBSTR_FLOOR; } // guaranteed inclusion
        if (textScore <= 0) { continue; } // no term hit and no substring — a real miss
        const final = textScore * (1 + W_RECENCY * this.recencyDecay(n.updatedAt) + W_DEGREE * Math.log1p(this.degree(n.id)));
        rows.push({ node: n, score: final, textScore, matched, substring });
      } else {
        rows.push({ node: n, score: this.recencyDecay(n.updatedAt), textScore: 0, matched: [], substring: false });
      }
    }
    rows.sort((a, b) => {
      if (mode === 'recent' || !textLower) {
        const r = (b.node.updatedAt || '').localeCompare(a.node.updatedAt || '');
        if (r !== 0) { return r; }
        return b.score - a.score;
      }
      if (b.score !== a.score) { return b.score - a.score; }
      return (b.node.updatedAt || '').localeCompare(a.node.updatedAt || '');
    });
    return rows.slice(0, limit);
  }

  /**
   * Search nodes by type and/or text. Thin wrapper over {@link scoredQuery}: with
   * `text` it returns relevance-ranked hits (item 1); without, recency order. The
   * old pure-substring behaviour survives as a guaranteed-inclusion subset.
   */
  query(opts: { type?: string; text?: string; id?: string; includeSuperseded?: boolean; limit?: number; mode?: 'relevance' | 'recent' }): GraphNode[] {
    return this.scoredQuery(opts).map((r) => r.node);
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

  // ── summaries (Tier 1, item 3) ────────────────────────────────────────────

  /** Distinct neighbour nodes of a node (via the adjacency index). */
  private neighborNodes(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    const seen = new Set<string>();
    for (const e of this.adjacency.get(id) || []) {
      const other = e.from === id ? e.to : e.from;
      if (seen.has(other)) { continue; }
      seen.add(other);
      const nn = this.nodes.get(other);
      if (nn) { out.push(nn); }
    }
    return out;
  }

  /** `parent_of` children of a node (this node as the parent). */
  private childrenOf(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    for (const e of this.adjacency.get(id) || []) {
      if (e.type === 'parent_of' && e.from === id) {
        const c = this.nodes.get(e.to);
        if (c) { out.push(c); }
      }
    }
    return out;
  }

  /**
   * DETERMINISTIC one-line rollup for an interior/hub node with NO authored
   * summary — NO LLM call. Synthesised from structure: child (or, absent
   * `parent_of` children, neighbour) type counts + the top child names by degree.
   * Returns undefined for a leaf/low-degree node (nothing to summarise).
   */
  rollupSummary(id: string): string | undefined {
    let kids = this.childrenOf(id);
    if (!kids.length) {
      if (this.degree(id) < 3) { return undefined; } // a leaf — no structure to roll up
      kids = this.neighborNodes(id);
    }
    if (!kids.length) { return undefined; }
    const counts = new Map<string, number>();
    for (const k of kids) { counts.set(k.type, (counts.get(k.type) || 0) + 1); }
    const countStr = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${c} ${t}`)
      .join(', ');
    const top = [...kids]
      .sort((a, b) => this.degree(b.id) - this.degree(a.id))
      .slice(0, 3)
      .map((k) => k.name);
    return `${countStr} · top: ${top.join(', ')}`;
  }

  /**
   * The summary to SHOW for a node: the authored one if present, else the
   * deterministic structural rollup (flagged synthesized), else nothing.
   */
  effectiveSummary(node: GraphNode): { text: string; synthesized: boolean } | undefined {
    if (node.summary && node.summary.trim()) { return { text: node.summary.trim(), synthesized: false }; }
    const roll = this.rollupSummary(node.id);
    return roll ? { text: roll, synthesized: true } : undefined;
  }

  /**
   * An AUTHORED summary is stale when the node has been superseded, or gained a
   * `parent_of` child AFTER the summary was written (`props.summaryAt`). Nodes
   * with no authored summary are "unsummarized", not stale.
   */
  summaryStale(node: GraphNode): boolean {
    if (!node.summary || !node.summary.trim()) { return false; }
    if (node.supersededBy) { return true; }
    const at = Date.parse(String(node.props?.summaryAt ?? node.updatedAt));
    if (!isFinite(at)) { return false; }
    for (const e of this.adjacency.get(node.id) || []) {
      if (e.type === 'parent_of' && e.from === node.id && Date.parse(e.createdAt) > at) { return true; }
    }
    return false;
  }

  private mapEntry(node: GraphNode): MapEntry {
    const es = this.effectiveSummary(node);
    return {
      id: node.id, type: node.type, name: node.name,
      summary: es?.text, synthesized: es?.synthesized,
      stale: this.summaryStale(node) || undefined,
      degree: this.degree(node.id),
    };
  }

  // ── cold-start anchor index (Tier 1, item 2) ───────────────────────────────

  /**
   * "Where do I start" for an agent with no id/name in hand. Ranks entities (and
   * any node when `focusType` unset) by degree() over the adjacency index, and
   * bundles the open `question`s, freshest `decision`s, and live `contradicts`
   * pairs it already knows how to find. Purely read-side; render via graphRender.
   */
  map(opts?: { depth?: number; focusType?: string; maxChildren?: number }): GraphMap {
    this.reloadIfChanged();
    const topK = Math.max(1, Math.min(50, opts?.maxChildren ?? 10));
    const focus = opts?.focusType ? String(opts.focusType).toLowerCase() : undefined;

    const live = [...this.nodes.values()].filter((n) => !n.supersededBy);
    const hubs = live
      .filter((n) => this.degree(n.id) > 0 && (!focus || n.type === focus))
      .sort((a, b) => this.degree(b.id) - this.degree(a.id) || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, topK)
      .map((n) => this.mapEntry(n));

    const freshest = (t: GraphNodeType): MapEntry[] => live
      .filter((n) => n.type === t)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, topK)
      .map((n) => this.mapEntry(n));

    // live (unsuperseded on both ends) contradicts pairs, deduped
    const seenPair = new Set<string>();
    const contradictions: GraphMap['contradictions'] = [];
    for (const e of this.edges.values()) {
      if (e.type !== 'contradicts') { continue; }
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b || a.supersededBy || b.supersededBy) { continue; }
      const key = [a.id, b.id].sort().join('|');
      if (seenPair.has(key)) { continue; }
      seenPair.add(key);
      contradictions.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name } });
      if (contradictions.length >= topK) { break; }
    }

    const pinned = this.pinnedNodes().slice(0, topK).map((n) => this.mapEntry(n));
    return { pinned, hubs, questions: freshest('question'), decisions: freshest('decision'), contradictions };
  }

  // ── pinned "core" tier (Tier 2, item 4) ────────────────────────────────────

  /** A node is pinned by `props.pinned===true` or by the reserved `props.area==='core'`. */
  private isPinnedNode(n: GraphNode): boolean {
    const p = (n.props || {}) as { pinned?: unknown; area?: unknown };
    return p.pinned === true || p.area === 'core';
  }

  /** Live pinned nodes (project invariants) — always prepended within budget. */
  pinnedNodes(): GraphNode[] {
    this.reloadIfChanged();
    return [...this.nodes.values()]
      .filter((n) => !n.supersededBy && this.isPinnedNode(n))
      .sort((a, b) => this.degree(b.id) - this.degree(a.id) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** Set/clear the pin flag on a node (upsert; the node stays otherwise unchanged). */
  pin(idOrName: string, pinned = true): GraphNode {
    this.reloadIfChanged();
    const n = this.getNode(idOrName);
    if (!n) { throw new GraphInvariantError(`${pinned ? 'pin' : 'unpin'}: node not found: ${idOrName}`); }
    const { node } = this.addNodeInternal(
      { type: n.type, name: n.name, id: n.id, props: { ...(n.props || {}), pinned } },
      { scaffold: false },
    );
    return node;
  }

  // ── reasoning-based best-first retrieval (Tier 1, item 4) ──────────────────

  /**
   * Vectorless, explainable, CITABLE retrieval — the PageIndex centrepiece done
   * without embeddings and without a server-side model (the calling agent is the
   * reasoner). Seed with the item-1 ranked query on `intent`, then best-first
   * expand a relevance-priority frontier: pop the best node, expand 1 hop
   * (strong provenance edges — supports/derived_from/produced/evaluates/
   * depends_on/parent_of — before weak relates_to/mentions), score newly-found
   * nodes against the intent, push. Stop at node_budget. Each returned row cites
   * `[id]` with the matched terms and the edge-path from its seed.
   */
  search(opts: { intent: string; nodeBudget?: number; hops?: number }): SearchResult {
    this.reloadIfChanged();
    const budget = Math.max(1, Math.min(60, opts.nodeBudget ?? 12));
    const hops = Math.max(1, Math.min(4, opts.hops ?? 2));
    const intent = String(opts.intent || '');
    const terms = Array.from(new Set(tokenize(intent)));
    const idf = this.idf();

    interface Rec { node: GraphNode; score: number; matched: string[]; seedId: string; depth: number; path: string[]; via?: SearchRow['via']; }
    const rows = new Map<string, Rec>();
    const frontier: { id: string; score: number; depth: number }[] = [];

    const seedK = Math.min(budget, Math.max(3, Math.ceil(budget / 2)));
    for (const s of this.scoredQuery({ text: intent, mode: 'relevance', limit: seedK })) {
      rows.set(s.node.id, { node: s.node, score: s.score, matched: s.matched, seedId: s.node.id, depth: 0, path: [] });
      frontier.push({ id: s.node.id, score: s.score, depth: 0 });
    }

    while (frontier.length && rows.size < budget) {
      frontier.sort((a, b) => b.score - a.score);
      const cur = frontier.shift() as { id: string; score: number; depth: number };
      if (cur.depth >= hops) { continue; }
      const curRec = rows.get(cur.id);
      if (!curRec) { continue; }
      const incident = [...(this.adjacency.get(cur.id) || [])]
        .sort((x, y) => (EDGE_STRENGTH[y.type] || 0) - (EDGE_STRENGTH[x.type] || 0));
      for (const e of incident) {
        if (rows.size >= budget) { break; }
        const otherId = e.from === cur.id ? e.to : e.from;
        if (rows.has(otherId)) { continue; }
        const other = this.nodes.get(otherId);
        if (!other || other.supersededBy) { continue; } // superseded hidden by default
        const { score: ts, matched } = this.scoreNode(other, terms, idf);
        const textScore = ts > 0 ? ts : SUBSTR_FLOOR * 0.5; // reachable-but-off-intent nodes stay citable, ranked low
        const final = textScore * (1 + W_RECENCY * this.recencyDecay(other.updatedAt) + W_DEGREE * Math.log1p(this.degree(otherId)));
        const dir: 'out' | 'in' = e.from === cur.id ? 'out' : 'in';
        const path = [...curRec.path, `${e.type}${dir === 'out' ? '→' : '←'} ${other.type}:${other.id}`];
        rows.set(otherId, { node: other, score: final, matched, seedId: curRec.seedId, depth: cur.depth + 1, path, via: { edge: e.type, fromId: cur.id, dir } });
        frontier.push({ id: otherId, score: final, depth: cur.depth + 1 });
      }
    }

    const out: SearchRow[] = [...rows.values()]
      .sort((a, b) => b.score - a.score)
      .map((r) => {
        const es = this.effectiveSummary(r.node);
        return {
          id: r.node.id, type: r.node.type, name: r.node.name,
          score: r.score, matched: r.matched,
          summary: es?.text, synthesized: es?.synthesized,
          inference: r.node.inference,
          seedId: r.seedId, via: r.via, path: r.path,
          conflicts: this.contradictionsFor(r.node.id),
        };
      });
    return { intent, terms, budget, hops, rows: out };
  }

  // ── navigable table-of-contents (Tier 2, item 2) ───────────────────────────

  private parentOfChildIds(id: string): string[] {
    const out: string[] = [];
    for (const e of this.adjacency.get(id) || []) {
      if (e.type === 'parent_of' && e.from === id) { out.push(e.to); }
    }
    return out;
  }
  private hasParentOfParent(id: string): boolean {
    return (this.adjacency.get(id) || []).some((e) => e.type === 'parent_of' && e.to === id);
  }
  private hasParentOfChild(id: string): boolean {
    return (this.adjacency.get(id) || []).some((e) => e.type === 'parent_of' && e.from === id);
  }

  /** Connected components of `pool` over the given (undirected) edge types. */
  private components(pool: GraphNode[], edgeTypes: string[]): GraphNode[][] {
    const idset = new Set(pool.map((n) => n.id));
    const parent = new Map<string, string>();
    const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x) as string) as string); x = parent.get(x) as string; } return x; };
    for (const n of pool) { parent.set(n.id, n.id); }
    const allow = new Set(edgeTypes);
    for (const e of this.edges.values()) {
      if (!allow.has(e.type) || !idset.has(e.from) || !idset.has(e.to)) { continue; }
      const ra = find(e.from), rb = find(e.to);
      if (ra !== rb) { parent.set(ra, rb); }
    }
    const groups = new Map<string, GraphNode[]>();
    for (const n of pool) { const r = find(n.id); const g = groups.get(r); if (g) { g.push(n); } else { groups.set(r, [n]); } }
    return [...groups.values()];
  }

  /**
   * Depth-bounded, summarized hierarchy (PageIndex-style "text-stripped overview →
   * drill"). The spine is `parent_of` (roots = entities with no incoming parent_of);
   * where that spine is sparse the uncovered remainder falls back to deterministic
   * clustering (by `props.area`, else connected components over relates_to/
   * depends_on). Each level shows the top `maxChildren` by degree and collapses the
   * rest to `+K more`. Summaries reuse {@link effectiveSummary}. Pass `root` to
   * expand one branch.
   */
  toc(opts?: { root?: string; depth?: number; focusType?: string; maxChildren?: number }): TocResult {
    this.reloadIfChanged();
    const depth = Math.max(1, Math.min(6, opts?.depth ?? 2));
    const maxChildren = Math.max(1, Math.min(50, opts?.maxChildren ?? 8));
    const focus = opts?.focusType ? String(opts.focusType).toLowerCase() : undefined;

    const build = (n: GraphNode, d: number, seen: Set<string>): TocNode => {
      seen.add(n.id);
      let kids = this.parentOfChildIds(n.id)
        .map((id) => this.nodes.get(id))
        .filter((c): c is GraphNode => !!c && !c.supersededBy && !seen.has(c.id));
      if (focus) { kids = kids.filter((c) => c.type === focus); }
      kids.sort((a, b) => this.degree(b.id) - this.degree(a.id) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      const childCount = kids.length;
      const cap = d > 1 ? maxChildren : 0;
      const shown = kids.slice(0, cap);
      const children = shown.map((c) => build(c, d - 1, seen));
      const es = this.effectiveSummary(n);
      const more = childCount - shown.length;
      return { id: n.id, type: n.type, name: n.name, summary: es?.text, synthesized: es?.synthesized, childCount, children, moreChildren: more > 0 ? more : undefined };
    };

    if (opts?.root) {
      const r = this.getNode(opts.root);
      return r ? { roots: [build(r, depth, new Set())] } : { roots: [] };
    }

    const seen = new Set<string>();
    const live = [...this.nodes.values()].filter((n) => !n.supersededBy);
    const spineRoots = live
      .filter((n) => this.hasParentOfChild(n.id) && !this.hasParentOfParent(n.id))
      .sort((a, b) => this.degree(b.id) - this.degree(a.id) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const roots: TocNode[] = spineRoots.map((r) => build(r, depth, seen));

    // Fall back to clustering for significant nodes the spine didn't cover.
    const synthCluster = (id: string, label: string, members: GraphNode[]): TocNode => {
      const sorted = [...members].sort((a, b) => this.degree(b.id) - this.degree(a.id));
      const shown = sorted.slice(0, maxChildren);
      const children = shown.map((m) => build(m, 1, seen));
      const more = members.length - shown.length;
      return { id, type: 'cluster', name: label, summary: `${members.length} node(s)`, childCount: members.length, children, moreChildren: more > 0 ? more : undefined };
    };
    const remaining = live.filter((n) => !seen.has(n.id) && this.degree(n.id) > 0);
    const clusterRoots: TocNode[] = [];
    if (remaining.length) {
      const byArea = new Map<string, GraphNode[]>();
      const rest: GraphNode[] = [];
      for (const n of remaining) {
        const area = typeof n.props?.area === 'string' ? (n.props.area as string) : undefined;
        if (area) { const g = byArea.get(area); if (g) { g.push(n); } else { byArea.set(area, [n]); } }
        else { rest.push(n); }
      }
      for (const [area, members] of byArea) { clusterRoots.push(synthCluster(`cluster:area:${slug(area)}`, `area: ${area}`, members)); }
      for (const comp of this.components(rest, ['relates_to', 'depends_on'])) {
        if (comp.length === 1) { continue; } // a lone node with only foreign edges — not a cluster
        const rep = [...comp].sort((a, b) => this.degree(b.id) - this.degree(a.id))[0];
        clusterRoots.push(synthCluster(`cluster:${rep.id}`, `cluster: ${rep.name}`, comp));
      }
      clusterRoots.sort((a, b) => b.childCount - a.childCount);
    }

    return { roots: [...roots, ...clusterRoots], clustered: roots.length === 0 && clusterRoots.length > 0 };
  }

  // ── hierarchical rollup / summary nodes (Tier 2, item 5) ────────────────────

  /** Deterministic id for a cluster's rollup node, so concurrent rollups upsert not duplicate. */
  private rollupId(center: GraphNode): string {
    const key = center.id.startsWith('entity:') ? center.id.slice('entity:'.length) : center.id.replace(/[^a-z0-9]+/gi, '-');
    return `summary:${key || 'x'}`;
  }

  /** parent_of descendants of a node (transitive), excluding itself. */
  private descendants(id: string): string[] {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const cid of this.parentOfChildIds(cur)) {
        if (cid !== id && !out.has(cid)) { out.add(cid); stack.push(cid); }
      }
    }
    return [...out];
  }

  private rollupFromMembers(memberIds: string[]): string {
    const counts = new Map<string, number>();
    for (const mid of memberIds) { const n = this.nodes.get(mid); if (n) { counts.set(n.type, (counts.get(n.type) || 0) + 1); } }
    const countStr = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c} ${t}`).join(', ');
    const top = memberIds.map((id) => this.nodes.get(id)).filter((n): n is GraphNode => !!n)
      .sort((a, b) => this.degree(b.id) - this.degree(a.id)).slice(0, 3).map((n) => n.name);
    return `${memberIds.length} member(s): ${countStr}${top.length ? ` · top: ${top.join(', ')}` : ''}`;
  }

  /** The rollup/summary node for a cluster centre, if one has been created. */
  rollupNodeFor(idOrName: string): GraphNode | undefined {
    this.reloadIfChanged();
    const c = this.getNode(idOrName);
    if (!c) { return undefined; }
    return this.nodes.get(this.rollupId(c));
  }

  /**
   * Create or upsert a hierarchical rollup for a cluster (item 5). The cluster is a
   * centre entity's `parent_of` descendants, or — absent a spine — its N-hop
   * neighbourhood. The rollup is a `note` with `props.rollup=true` and a
   * DETERMINISTIC id (`summary:<centre-key>`) so concurrent rollups of the same
   * cluster upsert rather than duplicate; it links `derived_from → each member`
   * (members stay fully addressable in `props.members`) and hangs under the centre
   * via `parent_of` so it's discoverable in the TOC. Summary text is agent-supplied
   * or the deterministic Tier-1 rollup (no LLM on the default path).
   */
  rollup(opts: { idOrName?: string; hops?: number; summary?: string }): { node: GraphNode; members: string[]; created: boolean } {
    this.reloadIfChanged();
    const center = opts.idOrName ? this.getNode(opts.idOrName) : undefined;
    if (!center) { throw new GraphInvariantError(`graph_rollup: centre node not found: ${opts.idOrName ?? ''}`); }
    const id = this.rollupId(center);
    let members = this.descendants(center.id);
    if (!members.length) {
      const hops = Math.max(1, Math.min(3, opts.hops ?? 1));
      const res = this.neighbors({ idOrName: center.id, hops, limit: 500 });
      members = (res ? res.nodes : []).map((n) => n.id).filter((mid) => mid !== center.id);
    }
    members = members.filter((mid) => mid !== id && !mid.startsWith('summary:'));
    const summaryText = (opts.summary && opts.summary.trim())
      ? opts.summary.trim()
      : (this.rollupSummary(center.id) || this.rollupFromMembers(members));
    const { node, created } = this.addNodeInternal({
      type: 'note', id, name: `Rollup: ${center.name}`,
      summary: summaryText,
      props: { rollup: true, of: center.id, members },
    }, { scaffold: false });
    this.linkParentOf(center.id, id);
    for (const m of members) {
      if (m === id || !this.nodes.has(m)) { continue; }
      if (!this.hasEdge('derived_from', id, m)) { this.addEdge({ type: 'derived_from', from: id, to: m }); }
    }
    return { node, members, created };
  }

  stats(): {
    nodeCount: number; edgeCount: number;
    nodesByType: Record<string, number>; edgesByType: Record<string, number>;
    superseded: number; isolated: number; contradictions: number; openQuestions: number;
    // Tier 1 summary telemetry (item 3)
    unsummarized: number; staleSummaries: number;
    // Tier 2 structure telemetry (items 1 + 4)
    spinelessHubs: number; pinned: number;
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
    // Types that benefit most from a summary (item 3).
    const SUMMARY_TYPES = new Set<GraphNodeType>(['entity', 'decision', 'question', 'artifact', 'agent_run']);
    let isolated = 0, unsummarized = 0, staleSummaries = 0, spinelessHubs = 0, pinned = 0;
    for (const n of this.nodes.values()) {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
      if (n.supersededBy) { superseded++; }
      if (n.type === 'question' && !n.supersededBy) { openQuestions++; }
      if (this.degree(n.id) === 0 && !n.supersededBy) { isolated++; }
      const hasSummary = !!(n.summary && n.summary.trim());
      if (!n.supersededBy && SUMMARY_TYPES.has(n.type) && !hasSummary) { unsummarized++; }
      if (hasSummary && this.summaryStale(n)) { staleSummaries++; }
      if (!n.supersededBy && this.isPinnedNode(n)) { pinned++; }
      // A hub with children (degree≥3) but NO parent_of spine — nudge to scaffold the tree (item 1).
      if (!n.supersededBy && n.type === 'entity' && this.degree(n.id) >= 3
          && !this.hasParentOfChild(n.id) && !this.hasParentOfParent(n.id)) { spinelessHubs++; }
      estTokens += estimateTokens(`${n.name}${n.summary ?? ''}${n.body ?? ''}`);
    }
    const contradictions = edgesByType['contradicts'] || 0;
    const live = this.nodes.size + this.edges.size;
    const deadWeight = Math.max(0, this.appliedOps - live);
    return {
      nodeCount: this.nodes.size, edgeCount: this.edges.size,
      nodesByType, edgesByType, superseded, isolated, contradictions, openQuestions,
      unsummarized, staleSummaries,
      spinelessHubs, pinned,
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
