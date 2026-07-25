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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GraphStore, GraphInvariantError, canonicalKey, estimateTokens,
} from '../out/graphStore.js';
import { fmtNode, renderNeighbors } from '../out/graphRender.js';

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

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nAll graphStore smoke assertions passed.');
