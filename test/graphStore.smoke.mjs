// Smoke test for the durable project graph (src/graphStore.ts + src/graphRender.ts).
// Run after `npm run build` (imports the compiled JS from out/). Extends the
// standalone pattern from commit 24ff52a. Proves the Tier 0 correctness/safety work:
//   (a) entity dedup — UsageService / usage-service / "usage service" → ONE entity
//   (b) incremental tail-apply == full replay after multi-agent appends
//   (c) schema-guided edge ontology rejects bad triples, accepts good ones
//   (d) contradictions are surfaced on reads (contradictionsFor + fmtNode marker)
//   (e) explicit truncation — body pointer + "…N more" budget marker (never silent)
//   (f) adjacency-index neighbors == a brute-force reference expansion
//   (+) torn FINAL line tolerated; corrupt MIDDLE line counted; stats telemetry
// And the Tier 1 (retrieval + orientation) work:
//   (g) relevance-ranked graph_query — OR-tokenized hit a substring missed; a
//       high-degree/summary node outranks a fresh trivial note; mode:'recent' differs
//   (h) graph_map cold-start index — hubs + open questions + decisions + live contradictions
//   (i) node summaries — round-trip; deterministic rollup when absent; legacy lines load; staleness
//   (j) graph_search — ranked, citable, best-first bundle with a path that prefers provenance edges

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GraphStore, GraphInvariantError, canonicalKey, estimateTokens,
} from '../out/graphStore.js';
import { fmtNode, renderNeighbors, renderMap, renderSearch } from '../out/graphRender.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };
const throws = (fn, rx, msg) => {
  try { fn(); failures++; console.error('  ✗ ' + msg + ' (no throw)'); }
  catch (e) {
    const m = String(e && e.message || e);
    if (e instanceof GraphInvariantError && (!rx || rx.test(m))) { console.log('  ✓ ' + msg); }
    else { failures++; console.error('  ✗ ' + msg + ' (wrong error: ' + m + ')'); }
  }
};

const mkWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-smoke-'));
const mkStore = (root, agent) => new GraphStore(root, { agentId: agent, runId: 'run-' + agent + '-' + Math.random().toString(16).slice(2, 8) });

// Snapshot the full observable state of a store via its PUBLIC api, so tail-apply
// and full-replay stores can be compared for provable identity.
const collectState = (store) => {
  const nodes = store.query({ includeSuperseded: true, limit: 200 })
    .map((n) => `${n.id}|${n.name}|${n.type}|${n.supersededBy ?? ''}|${n.updatedAt}`)
    .sort();
  const edgeSet = new Map();
  for (const n of store.query({ includeSuperseded: true, limit: 200 })) {
    const res = store.neighbors({ idOrName: n.id, hops: 1, limit: 200, includeConflicts: true });
    for (const e of (res ? res.edges : [])) { edgeSet.set(e.id, `${e.id}|${e.type}|${e.from}|${e.to}`); }
  }
  return { nodes, edges: [...edgeSet.values()].sort() };
};

// ── (a) entity dedup: camelCase / kebab / spaced / reordered → ONE entity ────
console.log('(a) entity dedup by canonical key');
{
  ok(canonicalKey('UsageService') === 'service-usage', 'canonicalKey(UsageService)=service-usage');
  ok(canonicalKey('usage-service') === 'service-usage', 'canonicalKey(usage-service)=service-usage');
  ok(canonicalKey('usage service') === 'service-usage', 'canonicalKey("usage service")=service-usage');
  ok(canonicalKey('Service Usage') === 'service-usage', 'canonicalKey("Service Usage")=service-usage (order-free)');

  const root = mkWorkspace();
  const s = mkStore(root, 'A');
  const a = s.addNode({ type: 'entity', name: 'UsageService' });
  const b = s.addNode({ type: 'entity', name: 'usage-service' });
  const c = s.addNode({ type: 'entity', name: 'usage service' });
  ok(a.node.id === b.node.id && b.node.id === c.node.id, 'all three spellings share one entity id: ' + a.node.id);
  ok(a.created === true && b.created === false && c.created === false, 'first creates, rest upsert');
  const entities = s.query({ type: 'entity', limit: 50 });
  ok(entities.length === 1, 'exactly ONE entity node stored (was silently duplicated before) — got ' + entities.length);
  ok(s.getNode('Usage Service')?.id === a.node.id, 'getNode resolves an unseen spelling to the same id');

  // legacy id stays addressable: seed a pre-canonical id, then a new spelling folds onto it
  const root2 = mkWorkspace();
  fs.mkdirSync(path.join(root2, '.autodev', 'graph'), { recursive: true });
  const legacy = { op: 'node', id: 'entity:usageservice', type: 'entity', name: 'UsageService', runId: 'r', agentId: 'legacy', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(root2, '.autodev', 'graph', 'graph.jsonl'), JSON.stringify(legacy) + '\n');
  const s2 = mkStore(root2, 'B');
  ok(s2.getNode('usage service')?.id === 'entity:usageservice', 'legacy entity id still resolves from a new spelling');
  const up = s2.addNode({ type: 'entity', name: 'usage-service' });
  ok(up.node.id === 'entity:usageservice' && up.created === false, 'new spelling upserts the legacy node, no duplicate');
}

// ── (b) incremental tail-apply == full replay ────────────────────────────────
console.log('(b) tail-apply identical to full replay (multi-agent)');
{
  const root = mkWorkspace();
  const A = mkStore(root, 'alice');
  const B = mkStore(root, 'bob'); // reads the same log incrementally

  const e1 = A.addNode({ type: 'entity', name: 'PaymentService' });
  const cl = A.addNode({ type: 'claim', name: 'charges in cents', source: 'pay.ts:10' });
  B.reloadIfChanged(); // tail-apply after two appends
  A.addEdge({ type: 'mentions', from: cl.node.id, to: e1.node.id });
  const art = A.addNode({ type: 'artifact', name: 'invoice.pdf', version: '1.0.0' });
  const run = A.addNode({ type: 'agent_run', name: 'nightly' });
  A.addEdge({ type: 'produced', from: run.node.id, to: art.node.id });
  B.reloadIfChanged(); // another tail-apply
  A.supersede(cl.node.id, { type: 'claim', name: 'charges in cents (confirmed)', source: 'pay.ts:12' });
  B.reloadIfChanged(); // tail-apply over a supersede op

  const fresh = mkStore(root, 'carol'); // constructor does a full replay
  const sB = collectState(B), sF = collectState(fresh);
  ok(JSON.stringify(sB.nodes) === JSON.stringify(sF.nodes), 'tail-applied NODES identical to full replay');
  ok(JSON.stringify(sB.edges) === JSON.stringify(sF.edges), 'tail-applied EDGES identical to full replay');

  const stB = B.stats(), stF = fresh.stats();
  ok(stB.nodeCount === stF.nodeCount && stB.edgeCount === stF.edgeCount, 'counts match (' + stB.nodeCount + 'n/' + stB.edgeCount + 'e)');
  ok(stB.superseded === stF.superseded && stB.superseded === 1, 'supersede reflected in both (superseded=1)');
  ok(stF.totalOps > stF.nodeCount + stF.edgeCount, 'dead-weight present (upserts/supersede): totalOps=' + stF.totalOps);
  ok(stF.deadWeight >= 1 && stF.deadWeightRatio > 0, 'deadWeight telemetry populated: ' + stF.deadWeight + ' (' + (stF.deadWeightRatio * 100).toFixed(0) + '%)');
}

// ── torn FINAL line tolerated; corrupt MIDDLE line surfaced ──────────────────
console.log('(b+) torn final line vs corrupt middle line');
{
  const root = mkWorkspace();
  const A = mkStore(root, 'a');
  const good = A.addNode({ type: 'note', name: 'first' });
  const file = A.path;
  // append a torn (newline-less) partial line — must be tolerated, not counted
  fs.appendFileSync(file, '{"op":"node","id":"note:partial","type":"note","na');
  A.reloadIfChanged();
  ok(A.stats().parseFailures === 0, 'torn final line is NOT counted as a parse failure');
  ok(A.getNode('note:partial') === undefined, 'torn final line not applied yet');
  // finish the line + a following newline → it should now apply
  fs.appendFileSync(file, 'me":"second","runId":"r","agentId":"x","createdAt":"2020-01-01T00:00:00.000Z","updatedAt":"2020-01-01T00:00:00.000Z"}\n');
  A.reloadIfChanged();
  ok(A.getNode('note:partial')?.name === 'second', 'completed line is picked up on the next tick');

  // a COMPLETE but corrupt middle line increments parseFailures
  const root2 = mkWorkspace();
  const B = mkStore(root2, 'b');
  const f2 = B.path;
  B.addNode({ type: 'note', name: 'one' });
  fs.appendFileSync(f2, 'THIS IS NOT JSON\n');
  const good2 = B.addNode({ type: 'note', name: 'three' }); // valid line after the garbage
  const fresh = mkStore(root2, 'c');
  ok(fresh.stats().parseFailures === 1, 'a corrupt MIDDLE line is counted (parseFailures=1), got ' + fresh.stats().parseFailures);
  ok(fresh.getNode(good2.node.id)?.name === 'three', 'valid lines around the corrupt one still apply');
}

// ── (c) schema-guided edge ontology ──────────────────────────────────────────
console.log('(c) edge ontology: reject bad triples, accept good ones');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const run = s.addNode({ type: 'agent_run', name: 'run1' });
  const art = s.addNode({ type: 'artifact', name: 'out.bin', version: '1' });
  const evalN = s.addNode({ type: 'evaluation', name: 'eval1', rubric: 'correctness' });
  const claim = s.addNode({ type: 'claim', name: 'it works', inference: true });
  const commit = s.addNode({ type: 'commit', name: 'abc123' });
  const task = s.addNode({ type: 'task', name: 'ship it' });
  const entity = s.addNode({ type: 'entity', name: 'Widget' });

  // good triples
  ok(!!s.addEdge({ type: 'produced', from: run.node.id, to: art.node.id }), 'produced: agent_run→artifact accepted');
  ok(!!s.addEdge({ type: 'evaluates', from: evalN.node.id, to: art.node.id }), 'evaluates: evaluation→artifact accepted');
  ok(!!s.addEdge({ type: 'supports', from: commit.node.id, to: claim.node.id }), 'supports: *→claim accepted');
  ok(!!s.addEdge({ type: 'resolved_to', from: commit.node.id, to: entity.node.id }), 'resolved_to: *→entity accepted');
  ok(!!s.addEdge({ type: 'depends_on', from: task.node.id, to: commit.node.id }), 'depends_on: *→* accepted');

  // bad triples
  throws(() => s.addEdge({ type: 'evaluates', from: commit.node.id, to: task.node.id }), /evaluates.*expects/, 'evaluates: commit→task rejected');
  throws(() => s.addEdge({ type: 'produced', from: task.node.id, to: art.node.id }), /produced.*expects/, 'produced: task→artifact rejected (from must be agent_run)');
  throws(() => s.addEdge({ type: 'supports', from: run.node.id, to: task.node.id }), /supports.*expects/, 'supports: *→task rejected (to must be claim)');
  throws(() => s.addEdge({ type: 'resolved_to', from: run.node.id, to: task.node.id }), /resolved_to.*expects/, 'resolved_to: *→task rejected (to must be entity)');
}

// ── (d) contradictions surfaced on reads ─────────────────────────────────────
console.log('(d) contradictions surfaced (data + fmtNode marker)');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const c1 = s.addNode({ type: 'claim', name: 'timeout is 30s', source: 'a.ts:1' });
  const c2 = s.addNode({ type: 'claim', name: 'timeout is 60s', source: 'b.ts:1' });
  s.addEdge({ type: 'contradicts', from: c2.node.id, to: c1.node.id });

  const conf1 = s.contradictionsFor(c1.node.id);
  ok(conf1.length === 1 && conf1[0].id === c2.node.id, 'contradictionsFor sees the incident contradicts edge (either direction)');
  const line = fmtNode(s.getNode(c1.node.id), conf1);
  ok(line.includes('⚠ contradicts') && line.includes(c2.node.id), 'fmtNode surfaces "⚠ contradicts [id]" inline');

  const infLine = fmtNode({ id: 'claim:x', type: 'claim', name: 'guessed', inference: true });
  ok(infLine.includes('inference:unverified'), 'inference is flagged as unverified uncertainty');

  // include_conflicts default keeps a contradicts edge visible even under an edge_types filter
  const res = s.neighbors({ idOrName: c1.node.id, hops: 1, edgeTypes: ['mentions'], includeConflicts: true });
  ok(res.edges.some((e) => e.type === 'contradicts'), 'include_conflicts surfaces contradicts under a mentions-only filter');
}

// ── (e) explicit truncation: body pointer + budget "…N more" marker ──────────
console.log('(e) explicit truncation (no silent clips)');
{
  const bigBody = 'x'.repeat(500);
  const line = fmtNode({ id: 'note:big', type: 'note', name: 'huge', body: bigBody });
  ok(line.includes('…(+300 chars — full via graph_query id=note:big)'), 'over-cap body ends with an explicit full-text pointer');

  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const center = s.addNode({ type: 'entity', name: 'Hub' });
  for (let i = 0; i < 12; i++) {
    const n = s.addNode({ type: 'note', name: 'leaf-' + i + '-with-a-fairly-long-name-to-cost-tokens' });
    s.addEdge({ type: 'relates_to', from: center.node.id, to: n.node.id });
  }
  const res = s.neighbors({ idOrName: center.node.id, hops: 1, limit: 200 });
  const rendered = renderNeighbors(res, { tokenBudget: 40, conflictsFor: () => [] });
  ok(/…\d+ more nodes \/ \d+ edges omitted \(token_budget\)/.test(rendered), 'tiny budget emits the explicit "…N more nodes / M edges omitted" marker');
  ok(rendered.includes('[' + center.node.id + ']'), 'the center is always kept even under a tiny budget');
  ok(estimateTokens('abcd') === 1, 'estimateTokens ~4 chars/token');
}

// ── (f) adjacency-index neighbors == brute-force reference ───────────────────
console.log('(f) adjacency neighbors == brute-force reference');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  // build a small graph
  const ids = {};
  for (const nm of ['A', 'B', 'C', 'D', 'E', 'F']) { ids[nm] = s.addNode({ type: 'entity', name: nm }).node.id; }
  const link = (a, b) => s.addEdge({ type: 'relates_to', from: ids[a], to: ids[b] });
  link('A', 'B'); link('B', 'C'); link('C', 'D'); link('A', 'E'); link('E', 'F'); link('B', 'D');

  // gather ALL edges for the brute-force reference
  const allEdges = [];
  { const seen = new Set(); for (const n of s.query({ includeSuperseded: true, limit: 200 })) {
      const r = s.neighbors({ idOrName: n.id, hops: 1, limit: 200 });
      for (const e of r.edges) { if (!seen.has(e.id)) { seen.add(e.id); allEdges.push(e); } }
  } }
  // reference: the OLD O(E·hops) expansion — rescan every edge each hop
  const brute = (centerId, hops) => {
    const nodeSet = new Set([centerId]); const edgeSet = new Set();
    let frontier = [centerId];
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const e of allEdges) {
        if (!(frontier.includes(e.from) || frontier.includes(e.to))) { continue; }
        edgeSet.add(e.id);
        for (const nid of [e.from, e.to]) { if (!nodeSet.has(nid)) { nodeSet.add(nid); next.push(nid); } }
      }
      frontier = next; if (!frontier.length) { break; }
    }
    return { nodes: [...nodeSet].sort(), edges: [...edgeSet].sort() };
  };

  for (const hops of [1, 2, 3]) {
    const ref = brute(ids.A, hops);
    const res = s.neighbors({ idOrName: ids.A, hops, limit: 200 });
    const got = { nodes: res.nodes.map((n) => n.id).sort(), edges: res.edges.map((e) => e.id).sort() };
    ok(JSON.stringify(got.nodes) === JSON.stringify(ref.nodes), `hops=${hops}: node set matches brute-force (${got.nodes.length} nodes)`);
    ok(JSON.stringify(got.edges) === JSON.stringify(ref.edges), `hops=${hops}: edge set matches brute-force (${got.edges.length} edges)`);
  }
  ok(s.degree(ids.B) === 3, 'degree() from adjacency index (B has 3 incident edges)');
}

// ── (g) relevance-ranked query (retires pure substring) ──────────────────────
console.log('(g) relevance-ranked graph_query');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  // A reordered multi-word intent the OLD substring path would MISS.
  const handler = s.addNode({ type: 'entity', name: 'Token Refresh Handler', body: 'handles the refresh flow' });
  s.addNode({ type: 'note', name: 'unrelated stuff' });
  const q = s.query({ text: 'refresh token flow' });
  ok(q.some((n) => n.id === handler.node.id), 'OR-tokenized multi-word query finds the reordered hit');
  const hay = `${'Token Refresh Handler'}\n${'handles the refresh flow'}`.toLowerCase();
  ok(!hay.includes('refresh token flow'), 'pure substring "refresh token flow" does NOT match — OR-tokenization is why it is found');
  ok(!s.query({ text: 'kubernetes deployment' }).length, 'a true miss (no term hits) still returns empty');

  // A high-degree, summarized hub outranks a fresh trivial note sharing a term.
  const root2 = mkWorkspace();
  const s2 = mkStore(root2, 'b');
  const hub = s2.addNode({ type: 'entity', name: 'Payments Core', summary: 'central payments module handling charges and refunds' });
  for (let i = 0; i < 5; i++) {
    const leaf = s2.addNode({ type: 'note', name: 'leaf ' + i });
    s2.addEdge({ type: 'relates_to', from: hub.node.id, to: leaf.node.id });
  }
  const fresh = s2.addNode({ type: 'note', name: 'payments quick jot' }); // freshest, trivial, degree 0
  const ranked = s2.query({ text: 'payments' });
  ok(ranked[0].id === hub.node.id, 'high-degree summarized hub ranks above the fresh trivial note (relevance ≠ recency)');
  const recent = s2.query({ text: 'payments', mode: 'recent' });
  ok(recent[0].id === fresh.node.id, "mode:'recent' restores pure recency — the fresh note is first");
  // scoredQuery exposes a score for graph_search to reuse
  const scored = s2.scoredQuery({ text: 'payments' });
  ok(scored[0].node.id === hub.node.id && scored[0].score > (scored[1] ? scored[1].score : 0), 'scoredQuery returns a numeric score, hub highest');
}

// ── (h) graph_map cold-start anchor index ────────────────────────────────────
console.log('(h) graph_map — hubs + questions + decisions + contradictions');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const hub = s.addNode({ type: 'entity', name: 'Auth Service', summary: 'authentication + sessions' });
  for (let i = 0; i < 4; i++) {
    const c = s.addNode({ type: 'claim', name: 'auth claim ' + i, inference: true });
    s.addEdge({ type: 'mentions', from: c.node.id, to: hub.node.id });
  }
  const qn = s.addNode({ type: 'question', name: 'is token rotation enabled?' });
  const dn = s.addNode({ type: 'decision', name: 'use JWT for sessions', summary: 'chose JWT over opaque tokens' });
  const c1 = s.addNode({ type: 'claim', name: 'ttl is 30s', source: 'a.ts:1' });
  const c2 = s.addNode({ type: 'claim', name: 'ttl is 60s', source: 'b.ts:1' });
  s.addEdge({ type: 'contradicts', from: c2.node.id, to: c1.node.id });

  const m = s.map();
  ok(m.hubs.length >= 1 && m.hubs[0].id === hub.node.id, 'graph_map ranks the top hub by degree');
  ok(m.hubs[0].name === 'Auth Service' && !!m.hubs[0].summary && m.hubs[0].synthesized !== true, 'hub carries its name + authored summary');
  ok(m.questions.some((x) => x.id === qn.node.id && /rotation/.test(x.name)), 'graph_map surfaces the open question by name');
  ok(m.decisions.some((x) => x.id === dn.node.id), 'graph_map surfaces the recent decision');
  ok(m.contradictions.some((p) => p.a.id === c1.node.id || p.b.id === c1.node.id), 'graph_map surfaces a live contradiction pair with names');
  const rendered = renderMap(m);
  ok(rendered.includes('Auth Service') && rendered.includes('⚔'), 'renderMap shows the hub name + a contradiction marker');
}

// ── (i) node summaries: round-trip, deterministic rollup, legacy load, staleness ─
console.log('(i) node summaries + deterministic rollup + staleness');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const e = s.addNode({ type: 'entity', name: 'Widget', summary: 'a small widget' });
  const fresh = mkStore(root, 'x'); // full replay from disk
  ok(fresh.getNode(e.node.id)?.summary === 'a small widget', 'summary round-trips through the append-only log');

  // deterministic rollup when a parent has children but no authored summary
  const parent = s.addNode({ type: 'entity', name: 'Module X' });
  for (const t of ['claim', 'artifact', 'artifact']) {
    const child = t === 'claim'
      ? s.addNode({ type: 'claim', name: t + ' child', inference: true })
      : s.addNode({ type: 'artifact', name: t + ' child', version: '1' });
    s.addEdge({ type: 'parent_of', from: parent.node.id, to: child.node.id });
  }
  const es = s.effectiveSummary(s.getNode(parent.node.id));
  ok(es && es.synthesized === true, 'rollup synthesized for an interior node with no authored summary (no LLM)');
  ok(/\d+ (claim|artifact)/.test(es.text) && es.text.includes('top:'), 'rollup lists child type counts + top child names');
  ok(s.effectiveSummary(s.getNode(e.node.id)).synthesized === false, 'authored summary is preferred over a rollup');

  // legacy summary-less JSONL still loads (purely additive)
  const root2 = mkWorkspace();
  fs.mkdirSync(path.join(root2, '.autodev', 'graph'), { recursive: true });
  const legacy = { op: 'node', id: 'note:old', type: 'note', name: 'legacy note', runId: 'r', agentId: 'old', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(root2, '.autodev', 'graph', 'graph.jsonl'), JSON.stringify(legacy) + '\n');
  const s2 = mkStore(root2, 'y');
  ok(s2.getNode('note:old')?.name === 'legacy note' && s2.getNode('note:old').summary === undefined, 'summary-less legacy line loads (summary=undefined)');

  // staleness: superseded → stale; and gains-a-child-after (via explicit timestamps) → stale
  const root3 = mkWorkspace();
  const s3 = mkStore(root3, 'z');
  const sup = s3.addNode({ type: 'decision', name: 'v1 choice', summary: 'the first call' });
  ok(s3.summaryStale(s3.getNode(sup.node.id)) === false, 'a fresh authored summary is not stale');
  s3.supersede(sup.node.id, { type: 'decision', name: 'v2 choice', summary: 'the revised call' });
  ok(s3.summaryStale(s3.getNode(sup.node.id)) === true, 'a superseded node with a summary is flagged stale');

  const root4 = mkWorkspace();
  fs.mkdirSync(path.join(root4, '.autodev', 'graph'), { recursive: true });
  const hubLine = { op: 'node', id: 'entity:hub', type: 'entity', name: 'Growing Hub', summary: 'starts small', props: { summaryAt: '2020-01-01T00:00:00.000Z' }, runId: 'r', agentId: 'o', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
  const kidLine = { op: 'node', id: 'note:kid', type: 'note', name: 'new child', runId: 'r', agentId: 'o', createdAt: '2021-06-01T00:00:00.000Z', updatedAt: '2021-06-01T00:00:00.000Z' };
  const edgeLine = { op: 'edge', id: 'edge:pk', type: 'parent_of', from: 'entity:hub', to: 'note:kid', runId: 'r', agentId: 'o', createdAt: '2021-06-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(root4, '.autodev', 'graph', 'graph.jsonl'), [hubLine, kidLine, edgeLine].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const s4 = mkStore(root4, 'w');
  ok(s4.summaryStale(s4.getNode('entity:hub')) === true, 'a summary goes stale when the node gains a child AFTER the summary was written');
  const st = s4.stats();
  ok(st.staleSummaries === 1, 'graph_stats counts staleSummaries=1, got ' + st.staleSummaries);
  ok(s.stats().unsummarized >= 1, 'graph_stats counts unsummarized nodes (Module X has none): ' + s.stats().unsummarized);
}

// ── (j) graph_search: ranked, citable, best-first, provenance-preferring ──────
console.log('(j) graph_search — ranked citable bundle, prefers provenance edges');
{
  const root = mkWorkspace();
  const s = mkStore(root, 'a');
  const svc = s.addNode({ type: 'entity', name: 'Usage Service', summary: 'meters api usage per tenant' });
  // A claim that does NOT match the intent by text — only reachable via a supports edge.
  const claim = s.addNode({ type: 'claim', name: 'billed amount is correct', source: 'u.ts:1', summary: 'amount matches the ledger' });
  s.addEdge({ type: 'supports', from: svc.node.id, to: claim.node.id }); // supports: *→claim
  // A weakly-related note, also off-intent — reachable only via relates_to.
  const weak = s.addNode({ type: 'note', name: 'random misc jotting' });
  s.addEdge({ type: 'relates_to', from: svc.node.id, to: weak.node.id });

  // Tight budget: after seeding the svc, only ONE neighbor fits — provenance must win.
  const tight = s.search({ intent: 'usage service', nodeBudget: 2, hops: 2 });
  ok(tight.rows.length === 2, 'node_budget respected (best-first, not fixed-N BFS): ' + tight.rows.length);
  ok(tight.rows.some((r) => r.id === claim.node.id), 'strong provenance (supports) neighbor is pulled into a tight budget');
  ok(!tight.rows.some((r) => r.id === weak.node.id), 'weak relates_to neighbor is dropped when budget is tight (provenance preferred)');
  const claimRow = tight.rows.find((r) => r.id === claim.node.id);
  ok(claimRow.via && claimRow.via.edge === 'supports', 'discovered claim cites the supports edge it arrived on');
  ok(claimRow.path.length >= 1 && /supports/.test(claimRow.path.join(' ')), 'row carries an explainable edge-path from its seed');
  ok(claimRow.seedId === svc.node.id, 'the row traces back to its seed');

  // Wider budget: the best-matching seed ranks first; the render cites [id] + WHY + edge.
  const res = s.search({ intent: 'usage service metering', nodeBudget: 12 });
  ok(res.rows[0].id === svc.node.id, 'the best-matching seed ranks first in the bundle');
  const rendered = renderSearch(res);
  ok(rendered.includes('[' + svc.node.id + ']') && /matched/.test(rendered), 'renderSearch cites [id] with a WHY');
  ok(/via .*supports/.test(rendered), 'render shows the supports provenance edge in a WHY line');
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nAll graphStore smoke assertions passed.');
