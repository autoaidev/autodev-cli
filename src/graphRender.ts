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

import type { GraphNode, GraphEdge } from './graphStore';

/** Max body chars shown inline before an explicit truncation pointer. */
export const BODY_CAP = 200;
/** Default token budget for a rendered neighbourhood. */
export const DEFAULT_TOKEN_BUDGET = 1500;

export interface Conflict { id: string; name: string; }

type FmtNodeInput = Pick<GraphNode, 'id' | 'type' | 'name'>
  & Partial<Pick<GraphNode, 'source' | 'version' | 'inference' | 'supersededBy' | 'body'>>;

/**
 * One node as a compact, citable line. `conflicts` are the node's incident
 * `contradicts` edges (from {@link GraphStore.contradictionsFor}); when present
 * they are appended as `⚠ contradicts [id] "name"`.
 */
export function fmtNode(n: FmtNodeInput, conflicts?: Conflict[]): string {
  const tags: string[] = [];
  if (n.source) { tags.push(`src=${n.source}`); }
  if (n.version) { tags.push(`v=${n.version}`); }
  if (n.inference) { tags.push('inference:unverified'); }
  if (n.supersededBy) { tags.push(`superseded→${n.supersededBy}`); }
  let body = '';
  if (n.body) {
    const clean = n.body.replace(/\s+/g, ' ').trim();
    body = clean.length > BODY_CAP
      ? ` — ${clean.slice(0, BODY_CAP)}…(+${clean.length - BODY_CAP} chars — full via graph_query id=${n.id})`
      : ` — ${clean}`;
  }
  const conf = (conflicts && conflicts.length)
    ? conflicts.map((c) => ` ⚠ contradicts [${c.id}] "${c.name}"`).join('')
    : '';
  return `- [${n.id}] ${n.type} "${n.name}"${tags.length ? ' (' + tags.join(', ') + ')' : ''}${body}${conf}`;
}

export interface NeighborsResult {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  dist: Record<string, number>;
}

/** ~4 chars per token. */
function estTokens(s: string): number { return Math.ceil(s.length / 4); }

/**
 * Render a bounded neighbourhood: rank nodes center → hop-proximity → recency,
 * fill to `tokenBudget`, then include only edges between shown nodes. Whatever
 * doesn't fit is reported EXPLICITLY as `…N more nodes / M edges omitted`.
 */
export function renderNeighbors(
  res: NeighborsResult,
  opts: { tokenBudget?: number; conflictsFor: (id: string) => Conflict[] },
): string {
  const budget = Math.max(200, opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const ranked = [...res.nodes].sort((x, y) => {
    if (x.id === res.center.id) { return -1; }
    if (y.id === res.center.id) { return 1; }
    const dx = res.dist[x.id] ?? 99, dy = res.dist[y.id] ?? 99;
    if (dx !== dy) { return dx - dy; }
    return (y.updatedAt || '').localeCompare(x.updatedAt || '');
  });

  const nodeLines: string[] = [];
  const shownIds = new Set<string>();
  let used = 0;
  for (const n of ranked) {
    const line = fmtNode(n, opts.conflictsFor(n.id));
    const cost = estTokens(line);
    if (nodeLines.length && used + cost > budget) { break; } // always keep the center
    nodeLines.push(line); shownIds.add(n.id); used += cost;
  }

  const shownEdges = res.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to));
  const edgeLines = shownEdges.map((e) => `- (${e.from}) -${e.type}-> (${e.to})${e.source ? ` [src=${e.source}]` : ''}`);
  const omittedNodes = res.nodes.length - shownIds.size;
  const omittedEdges = res.edges.length - shownEdges.length;

  let out = `Context around [${res.center.id}] "${res.center.name}":\n`
    + `NODES (${shownIds.size}/${res.nodes.length}):\n${nodeLines.join('\n')}\n`
    + `EDGES (${shownEdges.length}/${res.edges.length}):\n${edgeLines.join('\n') || '(none)'}`;
  if (omittedNodes > 0 || omittedEdges > 0) {
    out += `\n…${omittedNodes} more nodes / ${omittedEdges} edges omitted (token_budget); expand with graph_neighbors id=… or raise token_budget`;
  }
  return out;
}
