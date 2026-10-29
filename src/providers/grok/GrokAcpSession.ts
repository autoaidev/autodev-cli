// ---------------------------------------------------------------------------
// GrokAcpSession — grok's binding of the shared, provider-agnostic AcpSession.
//
// The whole ACP client (line-delimited JSON-RPC 2.0: initialize → session/new|
// load → session/prompt → session/update stream → cancel, one long-lived process
// per workspace root kept alive across turns) now lives in ../acp/AcpSession.
// This file is just grok's launch spec + backward-compatible re-exports, so the
// shipped grok persistent path (1.4.188) keeps working byte-for-byte while
// opencode (and later copilot/claude) reuse the exact same client.
//
// grok specifics: `grok agent --always-approve [-m MODEL] --no-leader … stdio`
// (parent opts BEFORE `stdio`), `--always-approve` so grok never asks for
// permission, and the standard-ACP decoder (which already reads grok's real tool
// name from `_meta['x.ai/tool'].name`).
// ---------------------------------------------------------------------------

import { AcpSession, decodeAcpUpdateStandard } from '../acp/AcpSession';
import type { AcpLaunchSpec } from '../acp/AcpSession';

// Backward-compatible re-exports (tui.ts + test/grokAcpSession.smoke.mjs import
// these from here). decodeAcpUpdate is the standard decoder — it already handles
// grok's `_meta['x.ai/tool']` tool-name extraction, so grok behaviour is
// unchanged.
export { extractToolOutput, classifyAcpResult, AcpSession } from '../acp/AcpSession';
export type { AcpHostHooks, AcpTurnResult, AcpUpdate, AcpLaunchSpec } from '../acp/AcpSession';
export const decodeAcpUpdate = decodeAcpUpdateStandard;

/** grok's ACP launch spec — the only provider-specific behaviour. */
export const GROK_ACP_SPEC: AcpLaunchSpec = {
  buildArgs(model: string | undefined, extraArgs: string[]): string[] {
    const args = ['agent', '--always-approve'];
    if (model) { args.push('-m', model); }
    args.push('--no-leader', ...extraArgs, 'stdio');
    return args;
  },
  decodeUpdate: decodeAcpUpdateStandard,
  narrationTitle: 'grok',
  narrateReasoning: false,
  authRequired: true,
};

/**
 * LEADER-CLIENT spec (Layer B, 1.4.193): a thin `grok agent … --leader
 * --leader-socket <sock> … stdio` client that connects to a shared leader daemon
 * instead of starting its own backend (replaces `--no-leader` with the leader
 * connect flags). The leader + a detached keepalive keep the session warm so this
 * client attaches WITHOUT session/load. Everything else (decoder, narration) is
 * identical to GROK_ACP_SPEC.
 */
export function grokLeaderClientSpec(socket: string): AcpLaunchSpec {
  return {
    buildArgs(model: string | undefined, extraArgs: string[]): string[] {
      const args = ['agent', '--always-approve'];
      if (model) { args.push('-m', model); }
      args.push('--leader', '--leader-socket', socket, ...extraArgs, 'stdio');
      return args;
    },
    decodeUpdate: decodeAcpUpdateStandard,
    narrationTitle: 'grok',
    narrateReasoning: false,
    authRequired: true,
  };
}

/**
 * One persistent `grok agent stdio` process for a workspace root. Thin subclass
 * that injects GROK_ACP_SPEC — all behaviour is in the shared AcpSession. When
 * `leaderSocket` is given it uses the LEADER-CLIENT spec + attach-without-load
 * (Layer B); otherwise the non-leader spec, byte-for-byte unchanged.
 */
export class GrokAcpSession extends AcpSession {
  constructor(opts: {
    root: string; model?: string; bin: string;
    hooks: import('../acp/AcpSession').AcpHostHooks;
    initialSessionId?: string; extraArgs?: string[];
    leaderSocket?: string; attachWithoutLoad?: boolean;
  }) {
    const spec = opts.leaderSocket ? grokLeaderClientSpec(opts.leaderSocket) : GROK_ACP_SPEC;
    super({ ...opts, spec, attachWithoutLoad: opts.attachWithoutLoad });
  }
}
