// ---------------------------------------------------------------------------
// opencode ACP — native `opencode acp` driven through the shared AcpSession.
//
// opencode ships FIRST-PARTY ACP (`opencode acp`, verified live on opencode
// 1.14.22): the same line-delimited JSON-RPC 2.0 protocol grok speaks, so we
// reuse the exact AcpSession client. One long-lived `opencode acp` process per
// workspace root, fed each turn, kept alive; resume only at (re)start via
// session/load (never minting a new session per turn — the opencode-session-
// explosion guard).
//
// This layer is the opencode BINDING of AcpSession:
//   - the launch spec: `opencode [-m MODEL] acp` (global -m BEFORE the acp
//     subcommand; the acp subcommand itself rejects -m). The MODEL comes from the
//     agent's settings (settings.opencodeModel) — a real, usable model. NB the
//     free `opencode/*` zen models return empty over raw ACP ("only usable from
//     within OpenCode"), so an empty clean turn is surfaced as a clear log.
//   - host hooks that emit the SAME canonical hook events (provider
//     'opencode-sdk') + live narration + secret redaction the SDK path emits, so
//     pixel-office sees an identical event stream whether opencode runs via ACP
//     or the createOpencode server.
//   - gate `AUTODEV_OPENCODE_ACP` (default ON when `opencode acp` is available)
//     with the createOpencode-server path as automatic fallback (wired in sdk.ts).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { AcpSession, decodeAcpUpdateStandard } from '../acp/AcpSession';
import type { AcpHostHooks, AcpLaunchSpec } from '../acp/AcpSession';
import { eventTypeFor } from '../base/ProviderNormalizer';
import { redactSecrets, redactDeep } from '../../core/redactSecrets';

const OPENCODE_BIN = 'opencode';

/** opencode's ACP launch spec. NB the model is NOT a CLI arg — `opencode acp`
 *  rejects `-m` (and the global `-m … acp` form exits 1). The model is injected
 *  via a merged OPENCODE_CONFIG file instead (see _writeAcpConfig). */
export const OPENCODE_ACP_SPEC: AcpLaunchSpec = {
  buildArgs(_model: string | undefined, extraArgs: string[]): string[] {
    return [...extraArgs, 'acp'];
  },
  decodeUpdate: decodeAcpUpdateStandard,
  narrationTitle: 'opencode',
  narrateReasoning: false, // keep opencode's agent_thought_chunk out of the feed
};

/**
 * Write a MERGED opencode config to `<root>/.autodev/opencode-acp.json` and return
 * its path — the workspace `opencode.json` (which carries autodev's office/operate
 * MCP) with the agent's model layered in (and permission:allow ensured). Pointed
 * at via OPENCODE_CONFIG so `opencode acp` runs the right model WITHOUT the CLI
 * -m flag and WITHOUT mutating the workspace file. Returns undefined on failure
 * (the session then just runs with opencode's own resolved config/model).
 */
function _writeAcpConfig(root: string, model: string | undefined): string | undefined {
  try {
    let cfg: Record<string, unknown> = {};
    const wsFile = path.join(root, 'opencode.json');
    if (fs.existsSync(wsFile)) {
      try { cfg = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as Record<string, unknown>; } catch { cfg = {}; }
    }
    if (!cfg['$schema']) { cfg['$schema'] = 'https://opencode.ai/config.json'; }
    if (model) { cfg['model'] = model; }
    if (!cfg['permission']) { cfg['permission'] = { '*': 'allow' }; } // empty client caps → opencode does its own I/O
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const out = path.join(dir, 'opencode-acp.json');
    fs.writeFileSync(out, JSON.stringify(cfg, null, 2), 'utf8');
    return out;
  } catch { return undefined; }
}

// --- persistent state (one AcpSession per root) ---------------------------
const _acpSessions = new Map<string, AcpSession>();
/** Roots with an opencode ACP turn dispatched (busy synchronously from dispatch
 *  through full drain — covers the window before AcpSession.runTurn sets busy). */
const _acpBusyRoots = new Set<string>();
const _latestSessionIds = new Map<string, string>();

// --- availability gate ----------------------------------------------------
let _opencodeAcpSupported: boolean | null = null;
/** Cached probe: is `opencode acp` a real subcommand? (opencode prints its help
 *  to STDERR, so we merge 2>&1 and look for the ACP banner.) */
export function opencodeAcpSupported(): boolean {
  if (_opencodeAcpSupported !== null) { return _opencodeAcpSupported; }
  try {
    const out = child_process.execSync(`${OPENCODE_BIN} acp --help 2>&1`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    _opencodeAcpSupported = /Agent Client Protocol|\bACP\b/i.test(out);
  } catch { _opencodeAcpSupported = false; }
  return _opencodeAcpSupported;
}

let _opencodeAcpTestOverride: boolean | null = null;
/** Test-only: force the ACP enablement decision. */
export function __setOpencodeAcpEnabledForTest(v: boolean | null): void { _opencodeAcpTestOverride = v; }

/**
 * Whether opencode should run over native ACP instead of the createOpencode
 * server. Gated by AUTODEV_OPENCODE_ACP (false/0/off/no forces the server path)
 * AND `opencode acp` being available. Default ON when available.
 */
export function opencodeAcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (_opencodeAcpTestOverride !== null) { return _opencodeAcpTestOverride; }
  const raw = String(env['AUTODEV_OPENCODE_ACP'] ?? '').toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') { return false; }
  return opencodeAcpSupported();
}

// --- canonical hook emission (parity with grok ACP + the opencode-sdk sink) --
function _emitOpencodeHook(root: string, hookEventName: string, extra: Record<string, unknown> = {}): void {
  try {
    const dir = path.join(root, '.autodev');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const ev = { hook_event_name: hookEventName, event_type: eventTypeFor(hookEventName), provider: 'opencode-sdk', cwd: root, timestamp: new Date().toISOString(), ...extra };
    fs.appendFileSync(path.join(dir, 'hooks-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* non-critical */ }
}

/** Get (or lazily create) the persistent opencode ACP session for a root. */
function _getOrCreate(root: string, model: string | undefined, log: (msg: string) => void, resumeSessionId: string | undefined): AcpSession {
  let sess = _acpSessions.get(root);
  if (sess) { return sess; }
  const seedId = resumeSessionId || _latestSessionIds.get(root) || undefined;
  const hooks: AcpHostHooks = {
    emitHook: (name, e) => {
      if (name === 'Notification' && typeof e['message'] === 'string') {
        const msg = redactSecrets(String(e['message'])).slice(0, 1200);
        if (!msg.trim()) { return; }
        _emitOpencodeHook(root, 'Notification', { ...e, message: msg });
      } else {
        _emitOpencodeHook(root, name, redactDeep(e));
      }
    },
    log,
  };
  const cfgPath = _writeAcpConfig(root, model);
  const extraEnv: Record<string, string> = cfgPath ? { OPENCODE_CONFIG: cfgPath } : {};
  sess = new AcpSession({ root, model, bin: OPENCODE_BIN, hooks, spec: OPENCODE_ACP_SPEC, initialSessionId: seedId, extraEnv });
  _acpSessions.set(root, sess);
  return sess;
}

/** True while an opencode ACP turn (incl. steered continuations) is running. */
export function isOpencodeAcpBusy(root: string): boolean {
  if (_acpBusyRoots.has(root)) { return true; }
  const s = _acpSessions.get(root);
  return !!s && s.isBusy();
}

/** Current tool activity label for the root (undefined = idle). */
export function getOpencodeAcpActivity(root: string): string | undefined {
  return _acpSessions.get(root)?.activity;
}

/** Latest opencode ACP session id (for resume-on-restart / session save). */
export function getOpencodeAcpLatestSessionId(root: string): string | undefined {
  return _acpSessions.get(root)?.sessionId ?? _latestSessionIds.get(root);
}

/** Is an opencode ACP session currently held for this root? */
export function hasOpencodeAcpSession(root: string): boolean {
  return _acpSessions.has(root);
}

/**
 * Run ONE turn through the persistent opencode ACP session. Mirrors the SDK
 * path's stdout/exit contract. On ACP startup failure, calls `onAcpUnavailable`
 * (the createOpencode-server fallback) and does NOT write the exit file itself.
 */
export function sendOpencodeAcpPrompt(
  root: string,
  promptFilePath: string,
  resumeSessionId: string | undefined,
  stdoutFile: string,
  exitFile: string,
  log: (msg: string) => void,
  model: string | undefined,
  showOutput: (() => void) | undefined,
  onAcpUnavailable: () => void,
): void {
  try { fs.writeFileSync(stdoutFile, '', 'utf8'); } catch { /* ignore */ }
  try { fs.writeFileSync(exitFile, '', 'utf8'); } catch { /* ignore */ }
  let promptText = '';
  try { promptText = fs.readFileSync(promptFilePath, 'utf8'); }
  catch (err) {
    try { fs.appendFileSync(stdoutFile, `\n[OpenCode ACP: cannot read prompt file: ${(err as Error)?.message ?? err}]\n`, 'utf8'); } catch { /* ignore */ }
    try { fs.writeFileSync(exitFile, '1\n', 'utf8'); } catch { /* ignore */ }
    return;
  }
  const sess = _getOrCreate(root, model, log, resumeSessionId);
  _acpBusyRoots.add(root); // synchronous busy (before runTurn flips its own flag)
  if (showOutput) { try { showOutput(); } catch { /* ignore */ } }
  const sink = (text: string): void => { try { fs.appendFileSync(stdoutFile, text, 'utf8'); } catch { /* ignore */ } };
  void (async () => {
    try {
      await sess.ensureReady();
    } catch (err) {
      log(`OpenCode ACP: startup failed (${(err as Error)?.message ?? err}); stderr="${sess.stderrSnapshot.slice(0, 200)}" — falling back to createOpencode server`);
      try { sess.close(); } catch { /* ignore */ }
      _acpSessions.delete(root);
      _acpBusyRoots.delete(root); // hand the busy flag over to the server path
      onAcpUnavailable();
      return;
    }
    if (sess.sessionId) { _latestSessionIds.set(root, sess.sessionId); }
    let res: { clean: boolean; stopReason: string; error?: string; emptyOutput?: boolean };
    try { res = await sess.runTurn(promptText, sink); }
    catch (err) { res = { clean: false, stopReason: 'exception', error: (err as Error)?.message ?? String(err) }; }
    if (res.emptyOutput) {
      log(`OpenCode ACP: turn produced NO output (stopReason=${res.stopReason}). The model "${model ?? '(default)'}" may be an unusable free zen model or misconfigured — set a real model (e.g. ollama-cloud/gpt-oss:20b or a configured provider) in the agent settings.`);
      try { fs.appendFileSync(stdoutFile, `\n[OpenCode ACP: empty turn — check the configured model "${model ?? '(default)'}"]\n`, 'utf8'); } catch { /* ignore */ }
    }
    if (!res.clean && res.error) {
      try { fs.appendFileSync(stdoutFile, `\n[OpenCode ACP: turn ended ${res.stopReason} — ${res.error}]\n`, 'utf8'); } catch { /* ignore */ }
    }
    try { fs.writeFileSync(exitFile, `${res.clean ? 0 : 1}\n`, 'utf8'); } catch { /* ignore */ }
    _acpBusyRoots.delete(root);
  })();
}

/** Steer the live opencode ACP process mid-turn (a queued session/prompt). */
export function steerOpencodeAcp(root: string, text: string, log: (msg: string) => void): boolean {
  const sess = _acpSessions.get(root);
  if (!sess || !sess.isAlive()) { return false; }
  const ok = sess.steer(text);
  if (ok) { log(`OpenCode ACP: steered live process (${text.length} chars) — queued to the running session`); }
  return ok;
}

/** Best-effort /compact on the live opencode ACP session (quiet, no Stop hook). */
export async function compactOpencodeAcp(root: string, log: (msg: string) => void): Promise<void> {
  const sess = _acpSessions.get(root);
  if (!sess) { return; }
  log('OpenCode ACP: requesting /compact');
  await sess.sendQuiet('/compact');
}

/** Force-clear busy + evict the ACP session for a root. */
export function forceIdleOpencodeAcp(root: string): void {
  _acpBusyRoots.delete(root);
  const sess = _acpSessions.get(root);
  if (sess) {
    if (sess.pid) { try { child_process.spawn('kill', ['-9', String(sess.pid)]); } catch { /* ignore */ } }
    try { sess.close(); } catch { /* ignore */ }
    _acpSessions.delete(root);
  }
}

/** Close + evict the opencode ACP session for a root (preserves session id). */
export function closeOpencodeAcp(root: string, log: (msg: string) => void): void {
  const sess = _acpSessions.get(root);
  if (sess) {
    log('OpenCode ACP: closing persistent session');
    try { sess.close(); } catch { /* ignore */ }
    _acpSessions.delete(root);
  }
  _acpBusyRoots.delete(root);
}

/** Close all opencode ACP sessions — extension deactivate. */
export function closeAllOpencodeAcp(): void {
  for (const [, sess] of _acpSessions) { try { sess.close(); } catch { /* ignore */ } }
  _acpSessions.clear();
  _acpBusyRoots.clear();
}
