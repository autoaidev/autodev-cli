// Offline smoke for the Claude token / context% signal.
//
// Proves extractClaudeUsage() turns a Claude transcript assistant message's
// `message.usage` block into the compact snapshot the pixel-office progress bar
// renders — contextTokens / contextPct / tokens computed correctly — and that
// the per-model context-limit table + guards behave.
//
// Fully offline. Run: node test/claudeUsage.smoke.mjs (after build).
import assert from 'node:assert';
import {
  extractClaudeUsage,
  contextLimitForModel,
  DEFAULT_CLAUDE_CONTEXT_LIMIT,
} from '../out/core/claudeUsage.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// ── Core computation: Opus 200k window, 40k context → exactly 20% ────────────
ok('Opus: 40k context tokens = 20% of the 200k window', () => {
  // A realistic Claude usage block: small live input + output, bulk in cache.
  // input(5000) + cache_read(30000) + cache_creation(5000) = 40000 context.
  const u = {
    input_tokens: 5000,
    output_tokens: 1200,
    cache_read_input_tokens: 30000,
    cache_creation_input_tokens: 5000,
  };
  const usage = extractClaudeUsage(u, 'claude-opus-4-8');
  assert.ok(usage, 'usage extracted');
  assert.equal(usage.contextTokens, 40000, 'contextTokens = input + cache_read + cache_creation');
  assert.equal(usage.contextPct, 20, '40000 / 200000 = 20%');
  // tokens = input + output (this turn's total), matching opencode's per-step total.
  assert.equal(usage.tokens, 6200, 'tokens = input_tokens + output_tokens');
  assert.equal(usage.inputTokens, 5000, 'inputTokens passthrough');
  assert.equal(usage.outputTokens, 1200, 'outputTokens passthrough');
});

// ── Sonnet: same 200k window; half-full → 50% ───────────────────────────────
ok('Sonnet: 100k context = 50%', () => {
  const usage = extractClaudeUsage(
    { input_tokens: 20000, output_tokens: 800, cache_read_input_tokens: 80000 },
    'claude-sonnet-4-5',
  );
  assert.equal(usage.contextTokens, 100000);
  assert.equal(usage.contextPct, 50);
  assert.equal(usage.tokens, 20800);
});

// ── contextPct is clamped to 0..100 and rounded to one decimal ──────────────
ok('contextPct clamps at 100 when context exceeds the window', () => {
  const usage = extractClaudeUsage({ input_tokens: 250000, output_tokens: 10 }, 'claude-opus-4-8');
  assert.equal(usage.contextPct, 100, 'over-full window pins to 100, never > 100');
});

ok('contextPct keeps one decimal of precision', () => {
  // 3333 / 200000 = 1.6665% → rounded to 1.7
  const usage = extractClaudeUsage({ input_tokens: 3333 }, 'claude-opus-4-8');
  assert.equal(usage.contextPct, 1.7, 'one-decimal rounding');
});

// ── Limit table: unknown / absent Claude model falls back to 200k ───────────
ok('unknown / absent model defaults to the 200k limit', () => {
  assert.equal(contextLimitForModel('claude-future-9-9'), DEFAULT_CLAUDE_CONTEXT_LIMIT);
  assert.equal(contextLimitForModel(undefined), 200000);
  assert.equal(contextLimitForModel('opus'), 200000);
  assert.equal(contextLimitForModel('claude-haiku-4'), 200000);
});

// ── Guards: absent / empty / malformed usage → null (caller keeps last known) ─
ok('absent or signal-free usage returns null', () => {
  assert.equal(extractClaudeUsage(undefined), null, 'undefined');
  assert.equal(extractClaudeUsage(null), null, 'null');
  assert.equal(extractClaudeUsage('nope'), null, 'non-object');
  assert.equal(extractClaudeUsage({}), null, 'empty object — no token signal');
  assert.equal(extractClaudeUsage({ input_tokens: 0, output_tokens: 0 }), null, 'all-zero → treated as absent');
});

ok('malformed / negative fields are coerced to 0, not trusted', () => {
  const usage = extractClaudeUsage(
    { input_tokens: 'x', output_tokens: -50, cache_read_input_tokens: 10000, cache_creation_input_tokens: null },
    'claude-opus-4-8',
  );
  assert.ok(usage, 'still extracts from the one valid field');
  assert.equal(usage.inputTokens, 0, 'non-numeric → 0');
  assert.equal(usage.outputTokens, 0, 'negative → 0');
  assert.equal(usage.contextTokens, 10000, 'only the valid cache_read counts');
  assert.equal(usage.contextPct, 5, '10000 / 200000 = 5%');
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
