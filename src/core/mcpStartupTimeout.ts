// ---------------------------------------------------------------------------
// mcpStartupTimeout — single source of truth for how long a provider waits for
// an MCP server to finish STARTING before killing it.
//
// The problem: slow MCP servers get killed by the per-CLI startup-timeout
// defaults. Grok kills at 30s; the official Blender Lab client clones a git repo
// and loads the full Blender docs on first run and needs ~90s. Each provider
// exposes its OWN knob (grounded below), so this module maps ONE setting
// (`mcpStartupTimeoutSec`, default 90) to the env var each provider family
// actually honors — never clobbering a pre-existing env override.
//
// Per-provider knobs (grounded against the real CLIs):
//   - grok   : env `GROK_MCP_STARTUP_TIMEOUT_SECS` (seconds). Grok IGNORES
//              `startup_timeout_sec` in .grok/config.toml — the env var is what
//              it actually honors. Injected at the grok spawn sites.
//   - claude : env `MCP_TIMEOUT` (Claude Code, MCP server startup, MILLISECONDS).
//              (`MCP_TOOL_TIMEOUT` covers tool-call execution — not startup.)
//   - opencode / copilot : no supported per-server MCP startup-timeout knob
//              (env or config). Nothing to inject — see mcpCatalog notes.
// ---------------------------------------------------------------------------

export const MCP_STARTUP_TIMEOUT_DEFAULT_SEC = 90;

export type ProviderFamily = 'grok' | 'claude' | 'opencode' | 'copilot';

/** Resolve the configured MCP startup timeout (seconds), falling back to 90. */
export function resolveMcpStartupTimeoutSec(settings?: { mcpStartupTimeoutSec?: number }): number {
  const s = settings?.mcpStartupTimeoutSec;
  return typeof s === 'number' && s > 0 ? s : MCP_STARTUP_TIMEOUT_DEFAULT_SEC;
}

/**
 * The MCP-startup-timeout env vars a provider family honors, for a given number
 * of seconds. Only returns vars NOT already present in `env` (so a user's own
 * export is never clobbered). Providers with no supported knob return `{}`.
 */
export function mcpStartupEnvForFamily(
  family: ProviderFamily,
  sec: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (family === 'grok') {
    if (!env['GROK_MCP_STARTUP_TIMEOUT_SECS']) { out['GROK_MCP_STARTUP_TIMEOUT_SECS'] = String(sec); }
  } else if (family === 'claude') {
    // Claude Code takes MILLISECONDS.
    if (!env['MCP_TIMEOUT']) { out['MCP_TIMEOUT'] = String(sec * 1000); }
  }
  // opencode / copilot: no knob — nothing to inject.
  return out;
}

/**
 * Set the provider family's MCP-startup-timeout env vars on `env`
 * (default process.env), only where unset. Returns the vars that were applied.
 */
export function applyMcpStartupEnv(
  family: ProviderFamily,
  settings?: { mcpStartupTimeoutSec?: number },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const toSet = mcpStartupEnvForFamily(family, resolveMcpStartupTimeoutSec(settings), env);
  for (const [k, v] of Object.entries(toSet)) { env[k] = v; }
  return toSet;
}
