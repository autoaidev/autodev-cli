import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import { saveAttachment } from './messageBuilder';
import { shortId } from './todo';
import { todoWriter } from './todoWriteManager';

// ---------------------------------------------------------------------------
// DiscordPoller — mirrors PHP DiscordTaskProvider (poll / drainQueue / react)
//
// Uses the Discord REST API to:
//   • Poll the channel for new messages from authorised owners
//   • Append received tasks to TODO.md
//   • React ✅ to every accepted message
//   • Fetch text from any file attachments and include them in the task
// ---------------------------------------------------------------------------

interface DiscordMessage {
  id: string;
  content: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  attachments: Array<{ url: string; filename: string }>;
}

interface QueuedTask {
  taskText: string;
  messageId: string;
  taskId: string;
}

const DISCORD_API = 'https://discord.com/api/v10';
const POLL_LIMIT = 10;

export class DiscordPoller {
  private lastMessageId: string | null = null;
  private queue: QueuedTask[] = [];
  private readonly owners: string[];
  private _onCommand: ((cmd: string) => void) | null = null;

  setOnCommand(cb: (cmd: string) => void): void { this._onCommand = cb; }

  /**
   * @param botToken       Discord bot token
   * @param channelId      Discord channel snowflake ID
   * @param ownersStr      Comma-separated list of usernames or user IDs allowed to send tasks
   */
  constructor(
    private readonly botToken: string,
    private readonly channelId: string,
    ownersStr: string,
  ) {
    this.owners = ownersStr.split(',').map(o => o.trim()).filter(Boolean);
  }

  /**
   * Seed lastMessageId with the current latest message in the channel so that
   * only messages arriving AFTER this point are treated as new tasks.
   * Call this once before starting the polling loop.
   */
  async initialize(): Promise<void> {
    try {
      const apiUrl = `${DISCORD_API}/channels/${this.channelId}/messages?limit=1`;
      const body = await apiGet(apiUrl, this.botToken);
      if (Array.isArray(body) && body.length > 0) {
        this.lastMessageId = (body[0] as DiscordMessage).id;
      }
    } catch { /* non-fatal — will just process existing messages on first poll */ }
  }

  /**
   * Poll the channel for new messages and append the first queued task to TODO.md.
   * Returns true if a task was appended (caller should break out of its wait sleep).
   */
  async pollAndAppend(todoPath: string, workspaceRoot?: string): Promise<boolean> {
    await this._fetchNewMessages(workspaceRoot);
    return this._drainQueue(todoPath);
  }

  // ---------------------------------------------------------------------------

  private async _fetchNewMessages(workspaceRoot?: string): Promise<void> {
    try {
      const qs = this.lastMessageId
        ? `?after=${this.lastMessageId}&limit=${POLL_LIMIT}`
        : `?limit=${POLL_LIMIT}`;
      const apiUrl = `${DISCORD_API}/channels/${this.channelId}/messages${qs}`;
      const body = await apiGet(apiUrl, this.botToken);
      if (!Array.isArray(body)) { return; }

      // Discord returns newest-first; reverse to process oldest first
      const messages = (body as DiscordMessage[]).reverse();

      for (const msg of messages) {
        // Advance cursor unconditionally so we never re-process messages
        if (!this.lastMessageId || msg.id > this.lastMessageId) {
          this.lastMessageId = msg.id;
        }

        if (msg.author?.bot) { continue; }

        const username = msg.author?.username ?? '';
        const userId = msg.author?.id ?? '';
        const isOwner = this.owners.some(
          o => o.toLowerCase() === username.toLowerCase() || o === userId,
        );
        if (!isOwner) { continue; }

        const parts: string[] = [];
        const text = (msg.content ?? '').trim();
        if (text) { parts.push(text); }

        // Pre-generate task ID so attachments share the same prefix
        const taskId = shortId();

        // Save any attached files to disk; reference by path in the task text
        for (const att of (msg.attachments ?? [])) {
          const data = await fetchAttachmentBuffer(att.url, this.botToken);
          if (data !== null) {
            if (workspaceRoot) {
              const relPath = saveAttachment(workspaceRoot, att.filename, data, taskId);
              parts.push(`[attachment: ${relPath}]`);
            } else {
              // fallback: inline as text when no workspace root
              parts.push(`--- attachment: ${att.filename} ---\n${data.toString('utf8')}`);
            }
          }
        }

        if (parts.length === 0) { continue; }

        const taskText = parts.join('\n');

        // Handle slash commands — don't queue as tasks
        if (taskText.trim().startsWith('/')) {
          reactToMessage(this.botToken, this.channelId, msg.id, '✅').catch(() => {});
          this._onCommand?.(taskText.trim());
          continue;
        }

        this.queue.push({ taskText, messageId: msg.id, taskId });

        // React ✅ to the message so the sender knows it was accepted
        reactToMessage(this.botToken, this.channelId, msg.id, '✅').catch(() => {});
      }
    } catch {
      // Polling failures are non-fatal — the loop will try again next tick
    }
  }

  private async _drainQueue(todoPath: string): Promise<boolean> {
    if (this.queue.length === 0) { return false; }
    const { taskText, taskId } = this.queue.shift()!;
    try {
      await todoWriter.append(todoPath, taskText, taskId);
    } catch { /* non-fatal */ }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiGet(rawUrl: string, botToken: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(rawUrl);
    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method: 'GET',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'AutoDev-VSCode/1.0',
        'Content-Type': 'application/json',
      },
    };
    const transport = rawUrl.startsWith('https') ? https : http;
    const req = transport.request(options, res => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

async function fetchAttachmentBuffer(attUrl: string, botToken: string): Promise<Buffer | null> {
  return new Promise(resolve => {
    const parsed = url.parse(attUrl);
    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method: 'GET',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'AutoDev-VSCode/1.0',
      },
    };
    const transport = attUrl.startsWith('https') ? https : http;
    const req = transport.request(options, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function reactToMessage(botToken: string, channelId: string, messageId: string, emoji: string): Promise<void> {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(emoji);
    const rawUrl = `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`;
    const parsed = url.parse(rawUrl);
    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'AutoDev-VSCode/1.0',
        'Content-Length': '0',
      },
    };
    const req = https.request(options, res => { res.resume(); resolve(); });
    req.on('error', () => resolve()); // non-fatal
    req.setTimeout(5_000, () => { req.destroy(); resolve(); });
    req.end();
  });
}
