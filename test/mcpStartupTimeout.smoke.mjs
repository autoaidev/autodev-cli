// Smoke test for the single-source MCP startup-timeout knob
// (src/core/mcpStartupTimeout.ts). Run after `npm run build`.
//
// Proves:
//   - the setting defaults to 90 (SETTINGS_DEFAULTS.mcpStartupTimeoutSec)
//   - resolveMcpStartupTimeoutSec falls back to 90, honors a positive override
//   - per-provider env mapping: grok → GROK_MCP_STARTUP_TIMEOUT_SECS (seconds),
//     claude → MCP_TIMEOUT (milliseconds); opencode/copilot → no env knob ({})
//   - a pre-existing env value is never clobbered

import {
  MCP_STARTUP_TIMEOUT_DEFAULT_SEC,
  resolveMcpStartupTimeoutSec,
  mcpStartupEnvForFamily,
} from '../out/core/mcpStartupTimeout.js';
import { SETTINGS_DEFAULTS } from '../out/core/settingsLoader.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

// ── default ─────────────────────────────────────────────────────────────────
ok(MCP_STARTUP_TIMEOUT_DEFAULT_SEC === 90, 'default constant = 90s');
ok(SETTINGS_DEFAULTS.mcpStartupTimeoutSec === 90, 'SETTINGS_DEFAULTS.mcpStartupTimeoutSec === 90');
ok(resolveMcpStartupTimeoutSec() === 90, 'resolve() with no settings → 90');
ok(resolveMcpStartupTimeoutSec({}) === 90, 'resolve({}) → 90');
ok(resolveMcpStartupTimeoutSec({ mcpStartupTimeoutSec: 0 }) === 90, 'resolve(0) → 90 (0 = unset)');
ok(resolveMcpStartupTimeoutSec({ mcpStartupTimeoutSec: 120 }) === 120, 'resolve(120) → 120 (override honored)');

// ── per-provider env mapping (empty env) ─────────────────────────────────────
{
  const grok = mcpStartupEnvForFamily('grok', 90, {});
  ok(grok['GROK_MCP_STARTUP_TIMEOUT_SECS'] === '90', 'grok → GROK_MCP_STARTUP_TIMEOUT_SECS=90 (seconds)');
  ok(!('MCP_TIMEOUT' in grok), 'grok mapping does not set MCP_TIMEOUT');

  const claude = mcpStartupEnvForFamily('claude', 90, {});
  ok(claude['MCP_TIMEOUT'] === '90000', 'claude → MCP_TIMEOUT=90000 (milliseconds)');

  const opencode = mcpStartupEnvForFamily('opencode', 90, {});
  ok(Object.keys(opencode).length === 0, 'opencode → no env knob ({})');
  const copilot = mcpStartupEnvForFamily('copilot', 90, {});
  ok(Object.keys(copilot).length === 0, 'copilot → no env knob ({})');
}

// ── never clobber a pre-existing env value ───────────────────────────────────
{
  const grok = mcpStartupEnvForFamily('grok', 90, { GROK_MCP_STARTUP_TIMEOUT_SECS: '300' });
  ok(Object.keys(grok).length === 0, 'grok: pre-existing env not clobbered ({})');
  const claude = mcpStartupEnvForFamily('claude', 90, { MCP_TIMEOUT: '250000' });
  ok(Object.keys(claude).length === 0, 'claude: pre-existing MCP_TIMEOUT not clobbered ({})');
}

if (failures) { console.error(`\nmcpStartupTimeout.smoke: ${failures} FAILED`); process.exit(1); }
console.log('\nmcpStartupTimeout.smoke: all passed');
