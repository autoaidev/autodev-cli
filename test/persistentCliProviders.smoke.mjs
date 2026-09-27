// Offline smoke — Phase 2 persistent-CLI dispatch routing.
//
// Verifies that claude-cli / copilot-cli / opencode-cli, when their
// persistence gate is ON, DISPATCH INTO THEIR PERSISTENT SIBLING'S in-process
// client (returning `{}` — no shell command, so the launcher never spawns a
// fresh per-turn process) and, when OFF, fall back to the legacy per-turn
// `{command}` path so nothing regresses.
//
// The sibling sender is swapped for a spy via the __set*SenderForTest seam so
// the ON path is exercised WITHOUT spawning a real claude/copilot/opencode.
//
// Run: node test/persistentCliProviders.smoke.mjs   (after npm run build)
import assert from 'node:assert';

import { ClaudeCliProvider, __setClaudeCliSenderForTest } from '../out/providers/claude/ProviderManager.js';
import { CopilotCliProvider, __setCopilotCliSenderForTest } from '../out/providers/copilot/ProviderManager.js';
import { OpenCodeCliProvider, __setOpencodeCliSenderForTest } from '../out/providers/opencode/ProviderManager.js';
import { DispatchRequestFactory } from '../out/providers/base/factories.js';
import { claudeCliPersistentEnabled, __setClaudeCliPersistentForTest } from '../out/providers/claude/tui.js';
import { copilotCliPersistentEnabled, __setCopilotCliPersistentForTest } from '../out/providers/copilot/sdk.js';
import { opencodeCliPersistentEnabled, __setOpencodeCliPersistentForTest } from '../out/providers/opencode/sdk.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

console.log('persistentCliProviders: Phase 2 dispatch routing');

const ROOT = '/tmp/autodev-persistent-cli-test';
const ctx = { log: () => {}, launcher: { launch() {} }, showOutput: () => {} };

// ---------------------------------------------------------------------------
// Predicate: honors the env off-switch (default depends on installed transport,
// so we only lock the deterministic off-switch here).
// ---------------------------------------------------------------------------
ok('claudeCliPersistentEnabled honors AUTODEV_CLAUDE_CLI_PERSISTENT=off', () => {
  assert.equal(claudeCliPersistentEnabled({ AUTODEV_CLAUDE_CLI_PERSISTENT: 'off' }), false);
  assert.equal(claudeCliPersistentEnabled({ AUTODEV_CLAUDE_CLI_PERSISTENT: '0' }), false);
  assert.equal(claudeCliPersistentEnabled({ AUTODEV_CLAUDE_CLI_PERSISTENT: 'false' }), false);
});
ok('copilotCliPersistentEnabled honors AUTODEV_COPILOT_CLI_PERSISTENT=off', () => {
  assert.equal(copilotCliPersistentEnabled({ AUTODEV_COPILOT_CLI_PERSISTENT: 'off' }), false);
});
ok('opencodeCliPersistentEnabled honors AUTODEV_OPENCODE_CLI_PERSISTENT=off', () => {
  assert.equal(opencodeCliPersistentEnabled({ AUTODEV_OPENCODE_CLI_PERSISTENT: 'off' }), false);
});

// ---------------------------------------------------------------------------
// claude-cli
// ---------------------------------------------------------------------------
await (async () => {
  const req = DispatchRequestFactory.make({ root: ROOT });

  // OFF → legacy per-turn command path (spawn-free, real).
  __setClaudeCliPersistentForTest(false);
  const off = await new ClaudeCliProvider().dispatch(req, ctx);
  ok('claude-cli OFF → returns a shell {command}', () => {
    assert.equal(typeof off.command, 'string');
    assert.ok(/claude/.test(off.command), 'command invokes claude');
    assert.ok(off.command.includes(req.exitFile), 'command writes the exit file');
  });

  // ON → routes to the persistent claude-tui StructuredClient sender, returns {}.
  let seen = null;
  __setClaudeCliSenderForTest((root, promptFile, sid, stdoutFile, exitFile) => {
    seen = { root, promptFile, sid, stdoutFile, exitFile };
  });
  __setClaudeCliPersistentForTest(true);
  const on = await new ClaudeCliProvider().dispatch(req, ctx);
  ok('claude-cli ON → returns {} (no command) + routes to claude-tui sender', () => {
    assert.equal(on.command, undefined, 'no shell command — persistent in-process');
    assert.ok(seen, 'sibling sender was invoked');
    assert.equal(seen.root, ROOT);
    assert.equal(seen.promptFile, req.combinedFile, 'sends the combined profile+message file');
    assert.equal(seen.stdoutFile, req.stdoutFile);
    assert.equal(seen.exitFile, req.exitFile);
  });
  __setClaudeCliSenderForTest(null);
  __setClaudeCliPersistentForTest(null);
})();

// ---------------------------------------------------------------------------
// copilot-cli
// ---------------------------------------------------------------------------
await (async () => {
  const req = DispatchRequestFactory.make({ root: ROOT });

  __setCopilotCliPersistentForTest(false);
  const off = await new CopilotCliProvider().dispatch(req, ctx);
  ok('copilot-cli OFF → returns a shell {command}', () => {
    assert.equal(typeof off.command, 'string');
    assert.ok(/copilot/.test(off.command), 'command invokes copilot');
  });

  let seen = null;
  __setCopilotCliSenderForTest((root, promptFile, sid, stdoutFile, exitFile) => {
    seen = { root, promptFile, sid, stdoutFile, exitFile };
  });
  __setCopilotCliPersistentForTest(true);
  const on = await new CopilotCliProvider().dispatch(req, ctx);
  ok('copilot-cli ON → returns {} (no command) + routes to copilot-sdk sender', () => {
    assert.equal(on.command, undefined);
    assert.ok(seen, 'sibling sender was invoked');
    assert.equal(seen.promptFile, req.combinedFile);
    assert.equal(seen.stdoutFile, req.stdoutFile);
    assert.equal(seen.exitFile, req.exitFile);
  });
  __setCopilotCliSenderForTest(null);
  __setCopilotCliPersistentForTest(null);
})();

// ---------------------------------------------------------------------------
// opencode-cli — also asserts the resolved session id is passed through so the
// SDK RESUMES it (never mints a new session per turn: opencode-session-explosion).
// ---------------------------------------------------------------------------
await (async () => {
  const req = DispatchRequestFactory.make({ root: ROOT, resolvedSessionId: 'ses_reuse_me' });

  __setOpencodeCliPersistentForTest(false);
  const off = await new OpenCodeCliProvider().dispatch(req, ctx);
  ok('opencode-cli OFF → returns a shell {command}', () => {
    assert.equal(typeof off.command, 'string');
    assert.ok(/opencode/.test(off.command), 'command invokes opencode');
  });

  let seen = null;
  __setOpencodeCliSenderForTest((root, promptFile, sid, stdoutFile, exitFile) => {
    seen = { root, promptFile, sid, stdoutFile, exitFile };
  });
  __setOpencodeCliPersistentForTest(true);
  const on = await new OpenCodeCliProvider().dispatch(req, ctx);
  ok('opencode-cli ON → returns {} + routes to opencode-sdk sender, RESUMING the session', () => {
    assert.equal(on.command, undefined);
    assert.ok(seen, 'sibling sender was invoked');
    assert.equal(seen.sid, 'ses_reuse_me', 'resumes the resolved session id (no new session)');
    assert.equal(seen.promptFile, req.combinedFile);
    assert.equal(seen.exitFile, req.exitFile);
  });
  __setOpencodeCliSenderForTest(null);
  __setOpencodeCliPersistentForTest(null);
})();

console.log(`\npersistentCliProviders: ${pass} checks passed`);
