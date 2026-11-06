// Smoke test for sumTranscriptUsage — the per-drain accumulation that gives the
// claude-cli `autodev start` path per-task tokens (usage lives only in the
// session transcript, which fires no token-bearing hook).
import assert from 'node:assert';
import { sumTranscriptUsage } from '../out/core/claudeUsage.js';

const asst = (model, i, o, cr) => JSON.stringify({
  type: 'assistant', uuid: `${i}-${o}-${cr}-${Math.random()}`,
  message: { model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 } },
});
const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });

console.log('claudeTranscriptUsage smoke');

// A drain spanning two assistant messages (a tool_result between them) must sum
// BOTH messages' input/output — not keep only the last.
{
  const d = sumTranscriptUsage([
    asst('claude-opus-4-8', 100, 200, 5000),
    toolResult,
    asst('claude-opus-4-8', 50, 300, 5400),
  ]);
  assert.ok(d, 'drain with usage returns a snapshot');
  assert.strictEqual(d.usage.inputTokens, 150, 'input summed 100+50');
  assert.strictEqual(d.usage.outputTokens, 500, 'output summed 200+300');
  assert.strictEqual(d.usage.tokens, 650, 'tokens = in+out');
  assert.strictEqual(d.usage.contextTokens, 5450, 'contextTokens tracks the LATEST message (50+5400), not summed');
  assert.strictEqual(d.model, 'claude-opus-4-8', 'model carried through');
  console.log('  ✓ multi-message drain sums input/output, context = latest');
}

// A drain with no assistant usage (tool_result only) returns null so the caller
// leaves its cached snapshot intact (no spurious zero-token increment).
{
  const d = sumTranscriptUsage([toolResult, toolResult, '']);
  assert.strictEqual(d, null, 'no-usage drain → null');
  console.log('  ✓ usage-free drain returns null (snapshot left intact)');
}

// Per-drain increments are disjoint: the office sums them server-side, so the
// task total equals the sum across drains.
{
  const d1 = sumTranscriptUsage([asst('claude-opus-4-8', 100, 200, 5000), asst('claude-opus-4-8', 50, 300, 5400)]);
  const d2 = sumTranscriptUsage([asst('claude-opus-4-8', 10, 90, 6000)]);
  const total = d1.usage.tokens + d2.usage.tokens;
  assert.strictEqual(total, 750, 'task total = Σ per-drain increments (650 + 100)');
  console.log('  ✓ per-drain increments compose to the task total');
}

// Malformed / partial JSON lines are skipped, not fatal.
{
  const d = sumTranscriptUsage(['{not json', asst('claude-sonnet-5-5', 10, 20, 0), '{"type":"assistant"']);
  assert.ok(d && d.usage.tokens === 30, 'skips junk lines, still sums the valid one');
  console.log('  ✓ malformed lines skipped');
}

// Zeroed usage (no tokens at all) yields null (extractClaudeUsage returns null).
{
  const d = sumTranscriptUsage([asst('claude-opus-4-8', 0, 0, 0)]);
  assert.strictEqual(d, null, 'all-zero usage → null');
  console.log('  ✓ all-zero usage → null');
}

console.log('claudeTranscriptUsage: 5 checks passed');
