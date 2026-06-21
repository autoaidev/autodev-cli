import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';

function uuid(): string { return crypto.randomUUID(); }

// ---------------------------------------------------------------------------
// A2A WebhookClient — mirrors PHP WebhookClient.php 1-to-1
//
// Emits proper A2A StreamResponse payloads (task | statusUpdate |
// artifactUpdate | message) and tracks contextId / taskId / artifactId state
// across the loop lifetime.
// ---------------------------------------------------------------------------

export type WebhookEvent =
  | 'agent_online' | 'agent_offline' | 'agent_idle'
  | 'loop_start' | 'loop_complete'
  | 'task_start' | 'task_done' | 'task_fail' | 'task_progress' | 'task_checkin'
  | 'task_output' | 'all_tasks_done'
  | 'rate_limit' | 'claude_output';

export class WebhookClient {
  private readonly contextId: string;
  private currentTaskId: string | null = null;
  private currentArtifactId: string | null = null;
  private meta: Record<string, unknown> = {};
  private _wsSender: ((frame: unknown) => boolean) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    contextId?: string,
  ) {
    this.contextId = contextId ?? uuid();
  }

  setMeta(meta: Record<string, unknown>): void { this.meta = meta; }

  /**
   * Provide a WebSocket sender function. When set and connected, events will
   * be sent over the WS connection instead of HTTP POST — avoiding the
   * mismatch of POSTing to a ws:// URL.
   */
  setWsSender(sender: (frame: unknown) => boolean): void {
    this._wsSender = sender;
  }

  send(event: WebhookEvent, payload: Record<string, unknown> = {}): void {
    const merged: Record<string, unknown> = { ...this.meta, event, ...payload };
    const body = this.toStreamResponse(event, merged);

    // Prefer WS delivery if a sender is wired up (frames are queued if not yet connected)
    if (this._wsSender) {
      this._wsSender(body);
      return;
    }

    if (!this.baseUrl) { return; }

    // Convert ws:// → http:// and wss:// → https:// for the HTTP fallback.
    // The WS server on port 6001 also accepts HTTP POST on /webhook/{slug}.
    const httpUrl = this.baseUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

    const headers: Record<string, string> = {
      'Content-Type': 'application/a2a+json',
      'User-Agent': 'AutoDev-VSCode/1.0',
    };
    if (this.apiKey) { headers['Authorization'] = `Bearer ${this.apiKey}`; }
    postJson(httpUrl, body, headers).catch(() => {});
  }

  private toStreamResponse(event: WebhookEvent, payload: Record<string, unknown>): unknown {
    const now = new Date().toISOString();
    switch (event) {
      case 'loop_start':
        this.currentTaskId = null; this.currentArtifactId = null;
        return { task: { id: uuid(), contextId: this.contextId,
          status: { state: 'TASK_STATE_SUBMITTED', timestamp: now }, metadata: payload } };

      case 'loop_complete':
        return { statusUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          status: { state: 'TASK_STATE_COMPLETED', timestamp: now }, metadata: { event: 'loop_complete', ...payload } } };

      case 'agent_online':
        return this.buildMessage('autodev online', payload, now);
      case 'agent_offline':
        return this.buildMessage('autodev going offline', payload, now);
      case 'agent_idle':
        return this.buildMessage('autodev idle', payload, now);
      case 'all_tasks_done':
        return this.buildMessage('All TODO tasks done — waiting for new tasks', payload, now);

      case 'task_start': {
        this.currentTaskId = uuid(); this.currentArtifactId = null;
        const taskObj = payload['task'];
        const taskText = typeof taskObj === 'string' ? taskObj
          : (taskObj && typeof taskObj === 'object' && 'text' in taskObj) ? String((taskObj as Record<string, unknown>)['text']) : '';
        return { statusUpdate: { taskId: this.currentTaskId, contextId: this.contextId,
          status: { state: 'TASK_STATE_WORKING', timestamp: now,
            message: { messageId: uuid(), role: 'ROLE_AGENT', parts: [{ text: taskText }] } },
          metadata: { event: 'task_start', ...payload } } };
      }

      case 'task_done': {
        const taskId = this.currentTaskId ?? uuid();
        this.currentTaskId = null; this.currentArtifactId = null;
        return { task: { id: taskId, contextId: this.contextId,
          status: { state: 'TASK_STATE_COMPLETED', timestamp: now }, metadata: payload } };
      }

      case 'task_fail': {
        const taskId = this.currentTaskId ?? uuid();
        const errorText = typeof payload['error'] === 'string' ? payload['error'] : 'Task failed';
        this.currentTaskId = null; this.currentArtifactId = null;
        return { task: { id: taskId, contextId: this.contextId,
          status: { state: 'TASK_STATE_FAILED', timestamp: now,
            message: { messageId: uuid(), role: 'ROLE_AGENT', parts: [{ text: errorText }] } },
          metadata: payload } };
      }

      case 'task_progress':
        return { statusUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          status: { state: 'TASK_STATE_WORKING', timestamp: now }, metadata: { event: 'task_progress', ...payload } } };

      case 'task_output': {
        if (!this.currentArtifactId) { this.currentArtifactId = uuid(); }
        const chunk = typeof payload['chunk'] === 'string' ? payload['chunk']
          : typeof payload['output'] === 'string' ? payload['output'] : '';
        return { artifactUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          artifact: { artifactId: this.currentArtifactId, parts: [{ text: chunk }] },
          append: true, lastChunk: false } };
      }

      case 'rate_limit':
        return { statusUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          status: { state: 'TASK_STATE_STOPPED', timestamp: now },
          metadata: { event: 'rate_limit', ...payload } } };

      case 'claude_output': {
        if (!this.currentArtifactId) { this.currentArtifactId = uuid(); }
        const out = typeof payload['output'] === 'string' ? payload['output'] : '';
        return { artifactUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          artifact: { artifactId: this.currentArtifactId, parts: [{ text: out }] },
          append: true, lastChunk: false } };
      }

      default:
        return { statusUpdate: { taskId: this.currentTaskId ?? uuid(),
          contextId: this.contextId,
          status: { state: 'TASK_STATE_WORKING', timestamp: now },
          metadata: { event, ...payload } } };
    }
  }

  private buildMessage(text: string, payload: Record<string, unknown>, _now: string): unknown {
    return { message: { messageId: uuid(), contextId: this.contextId,
      role: 'ROLE_AGENT', parts: [{ text }], metadata: payload } };
  }
}

// ---------------------------------------------------------------------------
// Discord — bot REST API (preferred) and plain webhook URL (fallback)
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
}

/**
 * Send a message via the Discord bot REST API.
 * Uses `Authorization: Bot {token}` targeting a specific channel.
 * Fire-and-forget.
 */
export function sendDiscordBotMessage(
  botToken: string,
  channelId: string,
  content: string,
): void {
  if (!botToken || !channelId) { return; }

  const apiUrl = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const MAX_LEN = 1900;
  const chunks = content.length <= MAX_LEN
    ? [content]
    : chunkString(content, MAX_LEN);

  for (let i = 0; i < chunks.length; i++) {
    const text = i === 0 ? chunks[i] : `(continued) ${chunks[i]}`;
    const headers: Record<string, string> = {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'AutoDev-VSCode/1.0',
    };
    postJson(apiUrl, { content: text }, headers).catch(_err => {
      // Discord failures are non-fatal
    });
  }
}

/** POST a message to a plain Discord webhook URL. Fire-and-forget. */
export function sendDiscordWebhook(webhookUrl: string, content: string, embed?: DiscordEmbed): void {
  if (!webhookUrl) { return; }

  const body: Record<string, unknown> = { content };
  if (embed) {
    body.embeds = [embed];
  }

  postJson(webhookUrl, body, {
    'Content-Type': 'application/json',
    'User-Agent': 'AutoDev-VSCode/1.0',
  }).catch(_err => {
    // Discord failures are non-fatal
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkString(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

function postJson(rawUrl: string, body: unknown, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(rawUrl);
    const json = JSON.stringify(body);
    const allHeaders = {
      ...headers,
      'Content-Length': String(Buffer.byteLength(json)),
    };

    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method: 'POST',
      headers: allHeaders,
    };

    const transport = rawUrl.startsWith('https') ? https : http;
    const req = transport.request(options, res => {
      res.resume(); // drain response
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Webhook responded with HTTP ${res.statusCode}`));
      } else {
        resolve();
      }
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Webhook request timed out')); });
    req.write(json);
    req.end();
  });
}
