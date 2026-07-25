/**
 * Presentation for the project graph — how nodes/subgraphs are rendered for the
 * model. Kept SEPARATE from the store (graphStore.ts) so it is pure and unit-
 * testable, and so Tier 1 (ranking / summaries / graph_search) can build on it.
 *
 * Two rules the model relies on:
 *  - Truncation is EXPLICIT — an over-cap body ends with a pointer to the full
 *    text; a token-budgeted subgraph reports what it omitted. Never a silent clip.
 *  - Uncertainty is VISIBLE — unverified inferences and incident `contradicts`
 *    edges are surfaced inline so a silently-conflicting fact can't slip past.
 */

import type { GraphNode, GraphEdge, GraphMap, SearchResult, TocResult, TocNode } from './graphStore';

/** Max body chars shown inline before an explicit truncation pointer. */
export const BODY_CAP = 200;
/** Default token budget for a rendered neighbourhood. */
export const DEFAULT_TOKEN_BUDGET = 1500;

export interface Conflict { id: string; name: string; }

type FmtNodeInput = Pick<GraphNode, 'id' | 'type' | 'name'>
  & Partial<Pick<GraphNode, 'source' | 'version' | 'inference' | 'supersededBy' | 'body' | 'summary'>>;

/** Extra summary presentation for {@link fmtNode} — a synthesized rollup and/or a staleness flag. */
export interface FmtOpts {
  /** A synthesized structural rollup to show when the node has no authored summary. */
  summary?: string;
  /** True when `summary` above is a deterministic rollup, not authored (renders `≡~`). */
  synthesized?: boolean;
  /** True when the node's AUTHORED summary is stale (superseded / gained children). */
  stale?: boolean;
}

/**
 * One node as a compact, citable line. `conflicts` are the node's incident
 * `contradicts` edges (from {@link GraphStore.contradictionsFor}); when present
 * they are appended as `⚠ contradicts [id] "name"`. A summary — authored (`≡`) or
 * a synthesized structural rollup via `opts.summary` (`≡~`) — is preferred over the
 * body as the node's gist (Tier 1, item 3).
 */
export function fmtNode(n: FmtNodeInput, conflicts?: Conflict[], opts?: FmtOpts): string {
  const tags: string[] = [];
  if (n.source) { tags.push(`src=${n.source}`); }
  if (n.version) { tags.push(`v=${n.version}`); }
  if (n.inference) { tags.push('inference:unverified'); }
  if (n.supersededBy) { tags.push(`superseded→${n.supersededBy}`); }

  const authored = n.summary && n.summary.trim() ? n.summary.trim() : '';
  const sumText = authored || (opts?.summary || '').trim();
  const synthesized = authored ? false : !!opts?.synthesized;
  if (authored && opts?.stale) { tags.push('summary:stale'); }

  let gist = '';
  if (sumText) {
    const clean = sumText.replace(/\s+/g, ' ').trim();
    const shown = clean.length > BODY_CAP ? `${clean.slice(0, BODY_CAP)}…` : clean;
    gist = ` ${synthesized ? '≡~' : '≡'} ${shown}`;
  } else if (n.body) {
    const clean = n.body.replace(/\s+/g, ' ').trim();
    gist = clean.length > BODY_CAP
      ? ` — ${clean.slice(0, BODY_CAP)}…(+${clean.length - BODY_CAP} chars — full via graph_query id=${n.id})`
      : ` — ${clean}`;
  }
  const conf = (conflicts && conflicts.length)
    ? conflicts.map((c) => ` ⚠ contradicts [${c.id}] "${c.name}"`).join('')
    : '';
  return `- [${n.id}] ${n.type} "${n.name}"${tags.length ? ' (' + tags.join(', ') + ')' : ''}${gist}${conf}`;
}

/** One map entry line: `[id] type "name" · deg=N ≡ summary`. */
function fmtMapEntry(e: GraphMap['hubs'][number]): string {
  const sum = e.summary
    ? ` ${e.synthesized ? '≡~' : '≡'} ${e.summary.replace(/\s+/g, ' ').trim().slice(0, BODY_CAP)}${e.stale ? ' (stale)' : ''}`
    : '';
  return `- [${e.id}] ${e.type} "${e.name}" · deg=${e.degree}${sum}`;
}

/**
 * Render the cold-start anchor index (Tier 1, item 2): the connectivity hubs plus
 * the open questions, freshest decisions, and live contradictions — the "where do
 * I start" entry point an agent reads at task start.
 */
export function renderMap(m: GraphMap): string {
  const sections: string[] = [];
  if (m.pinned && m.pinned.length) {
    sections.push(`PINNED · core (${m.pinned.length} — always shown):\n${m.pinned.map(fmtMapEntry).join('\n')}`);
  }
  sections.push(`HUBS (by connectivity, ${m.hubs.length}):\n${m.hubs.map(fmtMapEntry).join('\n') || '(none — graph is sparse or unlinked)'}`);
  if (m.questions.length) { sections.push(`OPEN QUESTIONS (${m.questions.length}):\n${m.questions.map(fmtMapEntry).join('\n')}`); }
  if (m.decisions.length) { sections.push(`RECENT DECISIONS (${m.decisions.length}):\n${m.decisions.map(fmtMapEntry).join('\n')}`); }
  if (m.contradictions.length) {
    sections.push(`LIVE CONTRADICTIONS (${m.contradictions.length}):\n`
      + m.contradictions.map((c) => `- [${c.a.id}] "${c.a.name}" ⚔ [${c.b.id}] "${c.b.name}"`).join('\n'));
  }
  return `Project graph map — where to start:\n${sections.join('\n')}\n`
    + `Expand any [id] with graph_neighbors, or dig a question with graph_search.`;
}

/**
 * Render a graph_search bundle (Tier 1, item 4): a ranked, citable list. Each row
 * cites `[id]` with a one-line WHY — the matched terms and the edge-path from its
 * seed — plus contradiction / unverified-inference flags. Vectorless + explainable.
 */
export function renderSearch(res: SearchResult): string {
  if (!res.rows.length) {
    return `graph_search "${res.intent}" — no nodes matched (terms: ${res.terms.join(', ') || '∅'}). Add facts with graph_add_node.`;
  }
  const lines = res.rows.map((r, i) => {
    const why: string[] = [];
    why.push(r.matched.length ? `matched {${r.matched.join(', ')}}` : 'reached via provenance');
    if (r.via) { why.push(`via ${r.via.fromId} —${r.via.edge}${r.via.dir === 'out' ? '→' : '←'}`); }
    else { why.push('seed'); }
    const flags: string[] = [];
    if (r.inference) { flags.push('⚠inference:unverified'); }
    for (const c of r.conflicts) { flags.push(`⚠contradicts [${c.id}]`); }
    const gist = r.summary ? `\n     ${r.synthesized ? '≡~' : '≡'} ${r.summary.replace(/\s+/g, ' ').trim().slice(0, BODY_CAP)}` : '';
    const pathStr = r.path.length ? `\n     path: ${res.rows[i].seedId} ▸ ${r.path.join(' ▸ ')}` : '';
    return `${i + 1}. [${r.id}] ${r.type} "${r.name}" (score=${r.score.toFixed(3)})`
      + ` — ${why.join('; ')}${flags.length ? ' · ' + flags.join(' ') : ''}${gist}${pathStr}`;
  });
  return `graph_search "${res.intent}" — ${res.rows.length} node(s), best-first ≤${res.budget}, ${res.hops} hop(s) (terms: ${res.terms.join(', ') || '∅'}):\n`
    + lines.join('\n');
}

export interface NeighborsResult {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  dist: Record<string, number>;
}

/** ~4 chars per token. */
function estTokens(s: string): number { return Math.ceil(s.length / 4); }

/** Effective (authored or synthesized) summary of a node, for the full-detail line. */
export type EffSummary = { text: string; synthesized: boolean } | undefined;

export interface RenderNeighborsOpts {
  tokenBudget?: number;
  conflictsFor: (id: string) => Conflict[];
  /** Pinned "core" nodes (item 4) — always prepended within budget, even off-neighbourhood. */
  pinned?: GraphNode[];
  /** Effective summary provider so a full line can show the authored/synthesized gist. */
  effectiveSummaryFor?: (n: GraphNode) => EffSummary;
  /** Deterministic branch rollup (item 5) — used to collapse a branch that won't fit. */
  rollupFor?: (id: string) => string | undefined;
}

/** A node line stripped to name-only (drops body/summary) — the first degradation tier. */
function nameOnlyLine(n: GraphNode, conflicts: Conflict[]): string {
  return fmtNode({ id: n.id, type: n.type, name: n.name, source: n.source, version: n.version, inference: n.inference, supersededBy: n.supersededBy }, conflicts);
}

/**
 * Render a bounded neighbourhood (Tier 2, item 4). Order: center → pinned core →
 * neighbours ranked by hop-proximity then recency. Fill to `tokenBudget`; when a
 * node won't fit, DEGRADE in tiers rather than silently drop — (a) body→name-only,
 * (b) substitute a branch's rollup summary for its members, (c) explicit
 * `…N more omitted`. Center + pinned nodes ALWAYS appear (degraded if need be).
 */
export function renderNeighbors(res: NeighborsResult, opts: RenderNeighborsOpts): string {
  const budget = Math.max(200, opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const centerId = res.center.id;
  const pinned = (opts.pinned || []).filter((n) => n.id !== centerId);
  const pinnedIds = new Set(pinned.map((n) => n.id));
  const ranked = [...res.nodes]
    .filter((n) => n.id !== centerId && !pinnedIds.has(n.id))
    .sort((x, y) => {
      const dx = res.dist[x.id] ?? 99, dy = res.dist[y.id] ?? 99;
      if (dx !== dy) { return dx - dy; }
      return (y.updatedAt || '').localeCompare(x.updatedAt || '');
    });
  const order = [res.center, ...pinned, ...ranked];

  // parent_of children within the candidate set — for branch rollup substitution (b).
  const candIds = new Set(order.map((n) => n.id));
  const childrenInSet = new Map<string, string[]>();
  for (const e of res.edges) {
    if (e.type === 'parent_of' && candIds.has(e.from) && candIds.has(e.to)) {
      const arr = childrenInSet.get(e.from); if (arr) { arr.push(e.to); } else { childrenInSet.set(e.from, [e.to]); }
    }
  }

  const fullLine = (n: GraphNode): string => {
    const es = opts.effectiveSummaryFor?.(n);
    return fmtNode(n, opts.conflictsFor(n.id), es ? { summary: es.synthesized ? es.text : undefined, synthesized: es.synthesized } : undefined);
  };

  const nodeLines: string[] = [];
  const shownIds = new Set<string>();
  const collapsedChildren = new Set<string>();
  let used = 0, degraded = 0, collapsed = 0;

  for (const n of order) {
    if (collapsedChildren.has(n.id)) { continue; } // represented by a parent's rollup line
    const must = n.id === centerId || pinnedIds.has(n.id);
    const full = fullLine(n);
    const fullCost = estTokens(full);
    if (!nodeLines.length || used + fullCost <= budget) {
      nodeLines.push(full); shownIds.add(n.id); used += fullCost; continue;
    }
    // (b) collapse a real branch to its rollup summary
    const kids = childrenInSet.get(n.id);
    const roll = kids && kids.length >= 2 ? opts.rollupFor?.(n.id) : undefined;
    if (roll) {
      const line = `- [${n.id}] ${n.type} "${n.name}" ≡~ ${roll.replace(/\s+/g, ' ').trim().slice(0, BODY_CAP)} (branch collapsed: token_budget)`;
      if (used + estTokens(line) <= budget) {
        nodeLines.push(line); shownIds.add(n.id); used += estTokens(line); collapsed++;
        for (const k of kids as string[]) { if (!shownIds.has(k)) { collapsedChildren.add(k); } }
        continue;
      }
    }
    // (a) name-only
    const name = `${nameOnlyLine(n, opts.conflictsFor(n.id))} (name-only: token_budget)`;
    if (must || used + estTokens(name) <= budget) {
      nodeLines.push(name); shownIds.add(n.id); used += estTokens(name); degraded++;
      continue;
    }
    // (c) omitted — counted below.
  }

  const shownEdges = res.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to));
  const edgeLines = shownEdges.map((e) => `- (${e.from}) -${e.type}-> (${e.to})${e.source ? ` [src=${e.source}]` : ''}`);
  const shownFromRes = res.nodes.filter((n) => shownIds.has(n.id)).length;
  const collapsedFromRes = res.nodes.filter((n) => collapsedChildren.has(n.id)).length;
  const omittedNodes = Math.max(0, res.nodes.length - shownFromRes - collapsedFromRes);
  const omittedEdges = res.edges.length - shownEdges.length;

  let out = `Context around [${res.center.id}] "${res.center.name}":\n`
    + `NODES (${shownIds.size} shown${pinned.length ? `, ${pinned.filter((p) => shownIds.has(p.id)).length} pinned` : ''}):\n${nodeLines.join('\n')}\n`
    + `EDGES (${shownEdges.length}/${res.edges.length}):\n${edgeLines.join('\n') || '(none)'}`;
  const notes: string[] = [];
  if (omittedNodes > 0 || omittedEdges > 0) { notes.push(`…${omittedNodes} more nodes / ${omittedEdges} edges omitted (token_budget)`); }
  if (collapsed > 0) { notes.push(`${collapsed} branch(es) collapsed to a rollup summary`); }
  if (degraded > 0) { notes.push(`${degraded} shown name-only`); }
  if (notes.length) { out += `\n${notes.join('; ')}; expand with graph_neighbors id=… or raise token_budget`; }
  return out;
}

/** Render one TOC node (and its subtree) as an indented outline with drill hints. */
function renderTocNode(n: TocNode, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);
  const sum = n.summary ? ` ${n.synthesized ? '≡~' : '≡'} ${n.summary.replace(/\s+/g, ' ').trim().slice(0, BODY_CAP)}` : '';
  const cc = n.childCount ? ` · ${n.childCount} child${n.childCount === 1 ? '' : 'ren'}` : '';
  lines.push(`${pad}- [${n.id}] ${n.type} "${n.name}"${cc}${sum}`);
  for (const c of n.children) { renderTocNode(c, indent + 1, lines); }
  if (n.moreChildren) { lines.push(`${'  '.repeat(indent + 1)}… +${n.moreChildren} more (drill: graph_toc root=${n.id})`); }
}

/**
 * Render a navigable table-of-contents (Tier 2, item 2) as an indented outline —
 * the PageIndex-style text-stripped overview. Each line carries `[id]` to drill a
 * branch (`graph_toc root=<id>`) and its one-line summary; over-cap children
 * collapse to `+K more`.
 */
export function renderToc(res: TocResult): string {
  if (!res.roots.length) {
    return 'graph_toc — empty (no parent_of spine or clusters yet). Add facts with a file:line source to auto-build the tree, or graph_rollup a cluster.';
  }
  const lines: string[] = [];
  for (const r of res.roots) { renderTocNode(r, 0, lines); }
  return `Project graph TOC${res.clustered ? ' (clustered — sparse parent_of spine)' : ''}:\n`
    + `${lines.join('\n')}\n`
    + 'Drill a branch: graph_toc root=<id>. Build the tree with file:line sources or graph_rollup.';
}
