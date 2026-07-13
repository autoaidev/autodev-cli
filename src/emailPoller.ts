import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { saveAttachment } from './messageBuilder';
import { shortId } from './todo';
import { todoWriter } from './todoWriteManager';

// ---------------------------------------------------------------------------
// EmailTaskPoller — IMAP poller that ingests new mail as TODO.md tasks.
//
// Strategy:
//   • Each poll: SEARCH UNSEEN, fetch each result, parse with mailparser,
//     save attachments via saveAttachment(), append a task via appendTask(),
//     then mark the message \Seen so the next SEARCH UNSEEN ignores it.
//   • SEARCH always round-trips to the server, so it picks up mail that
//     arrived after the connection was opened — unlike a cached UID watermark.
//   • Restart-safe: \Seen state lives on the server, so processed messages
//     are never re-ingested across VS Code restarts.
//
// Per https://imapflow.com/docs/examples/fetching-messages
// ---------------------------------------------------------------------------

export interface EmailPollerOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** Sender allowlist (regex/substring patterns). Empty array = allow NOBODY. */
  allowedSenders: string[];
  /** Verify TLS cert. Default true. */
  rejectUnauthorized?: boolean;
  /**
   * Require the receiving MTA's Authentication-Results header to show
   * dkim/spf=pass aligned to the sender domain before ingesting a message.
   * Default true — the From header is trivially spoofable and inbound mail runs
   * autonomous full-tool tasks. Set false only on a trusted internal relay.
   */
  requireAuth?: boolean;
  /**
   * Optional authserv-id of the trusted receiving MTA (the token that opens its
   * Authentication-Results header, e.g. "mx.google.com"). When set, only an AR
   * header stamped by this id is trusted — hardening against a forged topmost
   * header on an MTA that adds none of its own.
   */
  authServId?: string;
}

/** Relaxed domain alignment (RFC 5322.From domain vs DKIM d= / SPF mailfrom). */
function _domainAligned(a: string, b: string): boolean {
  a = a.replace(/\.$/, '').toLowerCase().trim();
  b = b.replace(/\.$/, '').toLowerCase().trim();
  if (!a || !b) { return false; }
  return a === b || b.endsWith('.' + a) || a.endsWith('.' + b);
}

/**
 * Decide whether a message is authenticated as genuinely from `senderDomain`.
 *
 * The From header is forgeable, so authorization must rest on the receiving
 * MTA's DKIM/SPF verdict. Only the TOPMOST Authentication-Results header is
 * trusted: a conformant MTA strips forged copies bearing its own authserv-id
 * and prepends its own, so the first AR line (as it appears in the raw header
 * block) is the one our server added; lines below it may be attacker-supplied
 * and are ignored. Requires dkim=pass with header.d aligned to the sender
 * domain, or spf=pass with smtp.mailfrom aligned. Returns false when no AR
 * header is present (fail closed).
 *
 * Exported for unit testing.
 */
export function emailPassesAuth(arLines: string[], senderDomain: string, authServId?: string): boolean {
  const domain = (senderDomain || '').toLowerCase().trim();
  if (!domain || arLines.length === 0) { return false; }
  // Trust only the topmost AR header (index 0 = first in the raw header block).
  const lc = arLines[0].toLowerCase().replace(/^authentication-results:\s*/, '');
  if (authServId) {
    const id = lc.split(/[;\s]/)[0].replace(/\.$/, '');
    if (id !== authServId.toLowerCase().trim().replace(/\.$/, '')) { return false; }
  }
  for (const m of lc.matchAll(/dkim=pass\b([^;]*)/g)) {
    const d = /header\.d=([a-z0-9.\-]+)/.exec(m[1]);
    if (d && _domainAligned(d[1], domain)) { return true; }
  }
  for (const m of lc.matchAll(/spf=pass\b([^;]*)/g)) {
    const f = /smtp\.mailfrom=([^;\s]+)/.exec(m[1]);
    if (f) {
      const mf = f[1].includes('@') ? f[1].split('@')[1] : f[1];
      if (_domainAligned(mf, domain)) { return true; }
    }
  }
  return false;
}

export class EmailTaskPoller {
  private client: ImapFlow | null = null;
  private connecting: Promise<void> | null = null;
  private polling = false;
  private readonly allowed: RegExp[];
  /**
   * Snapshot of UNSEEN UIDs that existed when the poller first connected.
   * Those messages are ignored — they were already in the inbox before the
   * loop started and aren't "new tasks". Cleared after the first poll.
   */
  private skipUids: Set<number> | null = null;
  /** Wall-clock time of the last successful connect — used to force a periodic
   *  reconnect so a long-running session doesn't sit on a half-dead socket the
   *  IMAP server has silently dropped. */
  private connectedAt = 0;
  /** Force a fresh IMAP connection every 15 minutes regardless of state. */
  private static readonly MAX_CONN_AGE_MS = 15 * 60 * 1000;

  private readonly requireAuth: boolean;
  private readonly authServId?: string;

  constructor(private readonly opts: EmailPollerOptions) {
    // Pre-compile each pattern to a regex — '*' acts as a wildcard.
    // e.g. "agent-*@company.com" matches "agent-bot@company.com".
    this.allowed = opts.allowedSenders
      .map(s => s.toLowerCase().trim())
      .filter(Boolean)
      .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    this.requireAuth = opts.requireAuth !== false; // default: require DKIM/SPF
    this.authServId = opts.authServId?.trim() || undefined;
  }

  /**
   * Connect once. Any UNSEEN message in the inbox — both pre-existing and
   * future arrivals — becomes a task. The poller marks each one \Seen after
   * processing so a restart never re-ingests it.
   */
  async initialize(): Promise<void> {
    await this._ensureConnected();
  }

  async pollAndAppend(todoPath: string, workspaceRoot?: string): Promise<boolean> {
    if (!workspaceRoot) return false;
    if (this.polling) return false; // never overlap polls
    this.polling = true;
    let appended = false;
    try {
      await this._ensureConnected();
      if (!this.client) return false;
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        // NOOP forces the server to send any pending EXISTS responses so the
        // SEARCH below sees mail that arrived since the last poll.
        try { await this.client.noop(); } catch { /* non-fatal */ }
        const uids = await this.client.search({ seen: false }, { uid: true });
        if (!Array.isArray(uids) || uids.length === 0) return false;

        for (const uid of uids) {
          if (this.skipUids?.has(uid)) continue;
          let processed = false;
          try {
            const msg = await this.client.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
            if (!msg || !msg.source) {
              // Mark seen anyway so we don't loop on it.
              await this.client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
              continue;
            }
            const parsed: ParsedMail = await simpleParser(msg.source);
            const senderAddr = parsed.from?.value?.[0]?.address ?? msg.envelope?.from?.[0]?.address;
            if (!this._senderAllowed(senderAddr)) {
              // Don't \Seen — leave for the human user to read.
              processed = true;
              continue;
            }
            // The From header is trivially spoofable, so a matching allowlist
            // entry is NOT proof of origin. Require the receiving MTA's
            // Authentication-Results (DKIM/SPF) to align with the sender domain
            // before turning the message into an autonomous, full-tool task.
            // Unauthenticated mail is left UNSEEN for the human to review.
            if (this.requireAuth && !this._isAuthenticated(parsed, senderAddr)) {
              processed = true;
              continue;
            }
            const taskText = await this._buildTaskFromMessage(parsed, msg.envelope, workspaceRoot);
            if (taskText) {
              await todoWriter.append(todoPath, taskText, shortId());
              appended = true;
            }
            await this.client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
            processed = true;
          } catch {
            // Skip this UID for now; another poll may succeed. To prevent a
            // hot loop on a permanently broken message, mark it \Seen.
            try { await this.client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch { /* ignore */ }
          } finally {
            if (processed) this.skipUids?.delete(uid);
          }
        }
        // After the first successful poll, the snapshot has done its job.
        if (this.skipUids && this.skipUids.size === 0) this.skipUids = null;
      } finally {
        lock.release();
      }
    } catch {
      // Drop the connection so the next poll reconnects cleanly.
      try { await this.client?.logout(); } catch { /* ignore */ }
      this.client = null;
      this.connecting = null;
      // Reset the skip-uid snapshot so the fresh connection takes a new one.
      this.skipUids = null;
    } finally {
      this.polling = false;
    }
    return appended;
  }

  async dispose(): Promise<void> {
    try { await this.client?.logout(); } catch { /* ignore */ }
    this.client = null;
    this.connecting = null;
    this.skipUids = null;
  }

  // -------------------------------------------------------------------------

  private async _ensureConnected(): Promise<void> {
    // Force a periodic reconnect — IMAP servers drop idle sockets without
    // warning, and `client.usable` lies until the next round-trip fails.
    if (this.client && this.client.usable && (Date.now() - this.connectedAt) > EmailTaskPoller.MAX_CONN_AGE_MS) {
      try { await this.client.logout(); } catch { /* ignore */ }
      this.client = null;
    }
    if (this.client && this.client.usable) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new ImapFlow({
        host: this.opts.host,
        port: this.opts.port,
        secure: this.opts.secure,
        auth: { user: this.opts.user, pass: this.opts.pass },
        logger: false,
        tls: { rejectUnauthorized: this.opts.rejectUnauthorized !== false },
      });
      try {
        await c.connect();
      } catch (err) {
        // Close the socket opened by ImapFlow before connect() threw so its
        // internal event listeners and TLS socket are not leaked.
        try { await c.logout(); } catch { /* ignore */ }
        throw err;
      }
      this.client = c;
      this.connectedAt = Date.now();
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private _senderAllowed(address?: string | null): boolean {
    // Fail closed: an empty allowlist allows NOBODY. Inbound email runs
    // autonomous, full-tool-access tasks, so it must never be an open relay for
    // anyone who guesses the mailbox address.
    if (this.allowed.length === 0) return false;
    if (!address) return false;
    const addr = address.toLowerCase();
    return this.allowed.some(p => p.test(addr));
  }

  /**
   * True if the receiving MTA authenticated this message as genuinely from the
   * sender's domain (DKIM or SPF pass, topmost Authentication-Results only).
   */
  private _isAuthenticated(parsed: ParsedMail, senderAddress?: string | null): boolean {
    const domain = senderAddress?.split('@')[1]?.toLowerCase().trim();
    if (!domain) { return false; }
    const arLines = (parsed.headerLines || [])
      .filter(h => h.key === 'authentication-results')
      .map(h => h.line);
    return emailPassesAuth(arLines, domain, this.authServId);
  }

  private async _buildTaskFromMessage(parsed: ParsedMail, envelope: any, workspaceRoot: string): Promise<string> {
    const subject = (parsed.subject || envelope?.subject || '(no subject)').trim();
    const fromAddr = parsed.from?.value?.[0]?.address ?? envelope?.from?.[0]?.address ?? 'unknown';
    const fromName = parsed.from?.value?.[0]?.name ?? '';
    const dateStr = (parsed.date ?? envelope?.date ?? new Date()).toISOString();
    const body = (parsed.text || '').trim();

    // Group attachments + the message file under one folder so they stay together.
    const groupId = `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const attachmentLines: string[] = [];
    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const att of parsed.attachments) {
        const name = att.filename || `attachment_${attachmentLines.length + 1}`;
        const rel = saveAttachment(workspaceRoot, name, att.content, groupId);
        attachmentLines.push(`- [${name}](/${rel})`);
      }
    }

    // Write the full email as a markdown file so the TODO line stays short
    // and the agent can read the whole message + attachment list from one file.
    const messageMd = [
      `# ${subject}`,
      '',
      `- **From:** ${fromName ? `${fromName} <${fromAddr}>` : fromAddr}`,
      `- **Date:** ${dateStr}`,
      attachmentLines.length ? `- **Attachments:** ${parsed.attachments!.length}` : '',
      '',
      '---',
      '',
      body || '_(no text body)_',
      attachmentLines.length ? '\n## Attachments\n\n' + attachmentLines.join('\n') : '',
    ].filter(Boolean).join('\n');
    const messageRel = saveAttachment(workspaceRoot, 'message.md', messageMd, groupId);

    return `Read the email message and work on the tasks mentioned: [${subject}](/${messageRel}) (from ${fromAddr})`;
  }
}
