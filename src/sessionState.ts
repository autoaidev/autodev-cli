import * as fs from 'fs';
import * as path from 'path';
import { ProviderId } from './providers';

// ---------------------------------------------------------------------------
// All autodev runtime files live under <workspace>/.autodev/
// ---------------------------------------------------------------------------

/** Returns the .autodev directory path, creating it if needed. */
export function autodevDir(root: string): string {
  const dir = path.join(root, '.autodev');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return dir;
}

/** .autodev/session-state.json — session IDs keyed by provider */
export const SESSION_STATE_FILE = '.autodev/session-state.json';

/** .autodev/TEMP_SESSION_OUT.txt — CLI stdout tee for session ID extraction */
export const SESSION_OUT_FILE = '.autodev/TEMP_SESSION_OUT.txt';

/** .autodev/TEMP_PROMPT.md — prompt written for CLI providers (legacy) */
export const PROMPT_FILE = '.autodev/TEMP_PROMPT.md';

/** .autodev/AGENT_PROFILE.md — profile instructions written per task */
export const AGENT_PROFILE_FILE = '.autodev/AGENT_PROFILE.md';

// ---------------------------------------------------------------------------
// Per-message output files
// ───────────────────────────────────────────────────────────────────────────
// Each CLI dispatch gets a unique messageId. Output and exit files live at:
//   .autodev/output/<providerId>/<messageId>.txt        ← stdout capture
//   .autodev/output/<providerId>/<messageId>.exit.txt   ← exit code
// A pointer file `.autodev/output/<providerId>.latest` always contains the
// current messageId, so existing callers of `stdoutFilePath/exitFilePath`
// transparently see the latest message's files without API changes.
//
// This prevents the previous bug where the shared per-provider file got
// overwritten between back-to-back tasks, sometimes losing the final output.
// ---------------------------------------------------------------------------

const MAX_MESSAGES_KEPT = 100; // delete older than this per provider

function outputBase(root: string): string {
  const dir = path.join(autodevDir(root), 'output');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return dir;
}

function pointerPath(root: string, providerId: string): string {
  return path.join(outputBase(root), `${providerId}.latest`);
}

function legacyStdoutPath(root: string, providerId: string): string {
  return path.join(outputBase(root), `${providerId}.txt`);
}

function legacyExitPath(root: string, providerId: string): string {
  return path.join(outputBase(root), `${providerId}-exit.txt`);
}

/** Read the messageId currently pointed at, or null if none yet. */
export function latestMessageId(root: string, providerId: string): string | null {
  try {
    const p = pointerPath(root, providerId);
    if (!fs.existsSync(p)) { return null; }
    const id = fs.readFileSync(p, 'utf8').trim();
    return id || null;
  } catch { return null; }
}

/** Path of the latest message's stdout file. Falls back to legacy path if
 *  no message has been rotated yet (so first-time installs keep working). */
export function stdoutFilePath(root: string, providerId: string): string {
  const id = latestMessageId(root, providerId);
  if (!id) { return legacyStdoutPath(root, providerId); }
  const dir = path.join(outputBase(root), providerId);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return path.join(dir, `${id}.txt`);
}

/** Path of the latest message's exit file. */
export function exitFilePath(root: string, providerId: string): string {
  const id = latestMessageId(root, providerId);
  if (!id) { return legacyExitPath(root, providerId); }
  const dir = path.join(outputBase(root), providerId);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return path.join(dir, `${id}.exit.txt`);
}

/** Rotate to a fresh messageId and return the empty stdout/exit file paths
 *  the dispatcher should write to and tee into. Updates the pointer file so
 *  every subsequent call to stdoutFilePath/exitFilePath returns these paths. */
export function newMessageOutput(
  root: string,
  providerId: string,
): { messageId: string; stdoutFile: string; exitFile: string } {
  const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(outputBase(root), providerId);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  const stdoutFile = path.join(dir, `${messageId}.txt`);
  const exitFile   = path.join(dir, `${messageId}.exit.txt`);
  // Atomically point at the new id BEFORE returning so concurrent readers see it
  fs.writeFileSync(pointerPath(root, providerId), messageId, 'utf8');
  // Best-effort cleanup of older messages
  pruneOldMessages(dir, MAX_MESSAGES_KEPT);
  return { messageId, stdoutFile, exitFile };
}

function pruneOldMessages(dir: string, keep: number): void {
  try {
    const files = fs.readdirSync(dir);
    // Distinct message IDs derived from filenames `<id>.txt` / `<id>.exit.txt`
    const ids = Array.from(new Set(
      files.map(f => f.replace(/\.exit\.txt$|\.txt$/, ''))
           .filter(id => id && id !== '')
    )).sort(); // lexicographic = chronological since IDs start with Date.now()
    const toDelete = ids.slice(0, Math.max(0, ids.length - keep));
    for (const id of toDelete) {
      try { fs.unlinkSync(path.join(dir, `${id}.txt`)); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(dir, `${id}.exit.txt`)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

type SessionMap = Partial<Record<string, string>>;

function readMap(root: string): SessionMap {
  try {
    const p = path.join(root, SESSION_STATE_FILE);
    if (fs.existsSync(p)) { return JSON.parse(fs.readFileSync(p, 'utf8')) as SessionMap; }
  } catch { }
  return {};
}

function writeMap(root: string, map: SessionMap): void {
  autodevDir(root); // ensure dir exists
  fs.writeFileSync(path.join(root, SESSION_STATE_FILE), JSON.stringify(map, null, 2), 'utf8');
}

export function getSessionId(root: string, providerId: ProviderId): string | undefined {
  return readMap(root)[providerId] ?? undefined;
}

export function saveSessionId(root: string, providerId: ProviderId, sessionId: string): void {
  const map = readMap(root);
  map[providerId] = sessionId;
  writeMap(root, map);
}

export function clearSessionId(root: string, providerId: ProviderId): void {
  const map = readMap(root);
  delete map[providerId];
  // Record the time of the clear so discovery helpers can ignore stale sessions
  map[`${providerId}-cleared-at`] = String(Date.now());
  writeMap(root, map);
}

/**
 * Returns the epoch-ms timestamp of the last clearSessionId() call for this
 * provider, or 0 if clearSessionId() has never been called.
 */
export function getSessionClearedAt(root: string, providerId: ProviderId): number {
  const raw = readMap(root)[`${providerId}-cleared-at`];
  return raw ? parseInt(raw, 10) : 0;
}

// ---------------------------------------------------------------------------
// Session display names — stored in session-state.json keyed by session ID
// ---------------------------------------------------------------------------

/** Save a human-readable display name for a session ID. */
export function saveSessionName(root: string, sessionId: string, name: string): void {
  const map = readMap(root);
  map[`name:${sessionId}`] = name;
  writeMap(root, map);
}

/** Get the saved display name for a session ID, or undefined if none. */
export function getSessionName(root: string, sessionId: string): string | undefined {
  return readMap(root)[`name:${sessionId}`] ?? undefined;
}

// ---------------------------------------------------------------------------
// Session ID extractors — scan raw stdout per provider
// ---------------------------------------------------------------------------

/** Claude: "session_id":"<id>" in --output-format stream-json events */
export function extractClaudeSessionId(stdout: string): string | undefined {
  return stdout.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1];
}

/** Copilot: "sessionId":"<id>" in JSON stream */
export function extractCopilotSessionId(stdout: string): string | undefined {
  return stdout.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
}

/** OpenCode: "sessionID":"ses_xxx" in --format json event stream */
export function extractOpenCodeSessionId(stdout: string): string | undefined {
  return stdout.match(/"sessionID"\s*:\s*"(ses_[^"]+)"/)?.[1];
}

/**
 * After a CLI task finishes, try to capture and persist the session ID.
 * - claude-cli:    reads from .autodev/output/claude-cli.txt (stdout tee)
 * - opencode-cli:  reads from .autodev/output/opencode-cli.txt (--format json tee)
 * - copilot-cli:   reads from .autodev/TEMP_SESSION_OUT.txt
 * Falls back silently — never throws.
 */
export function captureAndSaveSessionId(
  root: string,
  providerId: ProviderId,
  /** Fallback session ID (e.g. from findLatestClaudeSession for claude-cli) */
  fallbackSessionId?: string,
): void {
  try {
    // All CLI providers tee stdout to the per-message capture file now.
    // Falls back to the legacy SESSION_OUT_FILE only if the latest-message
    // file is absent (e.g. very first dispatch hasn't created a pointer yet).
    const captureFile = fs.existsSync(stdoutFilePath(root, providerId))
      ? stdoutFilePath(root, providerId)
      : path.join(root, SESSION_OUT_FILE);
    if (fs.existsSync(captureFile)) {
      const stdout = fs.readFileSync(captureFile, 'utf8');
      let id: string | undefined;
      if (providerId === 'claude-cli')    { id = extractClaudeSessionId(stdout); }
      if (providerId === 'copilot-cli')   { id = extractCopilotSessionId(stdout); }
      if (providerId === 'opencode-cli')  { id = extractOpenCodeSessionId(stdout); }
      if (id) { saveSessionId(root, providerId, id); return; }
    }
    if (fallbackSessionId) { saveSessionId(root, providerId, fallbackSessionId); }
  } catch { }
}
