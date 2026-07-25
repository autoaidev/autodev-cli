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

import type { GraphNode, GraphEdge, GraphMap, SearchResult } from './graphStore';

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
