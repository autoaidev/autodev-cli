// ---------------------------------------------------------------------------
// Slash-command whitelist shared by every inbound transport (WS / HTTP webhook
// / Discord). Only text that EXACTLY matches a known control command may be
// diverted away from the TODO queue to _handleCommand. Any other slash-prefixed
// text (e.g. "/login is broken", "/etc/nginx needs a tweak") is an ordinary
// task and must still be appended, never silently dropped.
// ---------------------------------------------------------------------------

/** Exact control commands recognized by TaskLoop._handleCommand. */
export const KNOWN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  '/restart',
  '/clear',
  '/retry',
  '/resume',
]);

/** True only when `text` is exactly one of the known control commands. */
export function isKnownSlashCommand(text: string): boolean {
  if (typeof text !== 'string') { return false; }
  return KNOWN_SLASH_COMMANDS.has(text.trim().toLowerCase());
}
