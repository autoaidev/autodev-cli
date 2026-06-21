import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import { saveAttachment } from './messageBuilder';
import { shortId } from './todo';
import { todoWriter } from './todoWriteManager';
import { WebSocketPoller } from './webSocketPoller';

// ---------------------------------------------------------------------------
// WebhookPoller — mirrors PHP AutodevWebhookTaskProvider
//
// Supports two modes based on the serverBaseUrl scheme:
//
//  http:// / https://  → HTTP polling (GET /v1/logs every 3 s, ETag caching)
//  ws://  / wss://     → Persistent WebSocket connection; receives pushed frames
//
// HTTP API used:
//   GET  {baseUrl}/v1/logs?status=pending&per_page=1&endpoint_slug={slug}
//   GET  {baseUrl}/v1/logs/{id}
//   PATCH {baseUrl}/v1/logs/{id}  { status: 'received' }
//
// WebSocket: connects to ws(s)://{host}:{port}/?token={apiKey}&endpoint={slug}
//   Incoming frames are pure A2A StreamResponse JSON.
//   A task frame with status.state=TASK_STATE_SUBMITTED and metadata.event=user_message
//   causes the task text to be appended to TODO.md.
//
// Auth: X-API-Key header (HTTP) / token query param (WebSocket)
// ---------------------------------------------------------------------------

interface LogListItem {
  id: number;
}

interface A2APart {
  kind: string;
  text?: string;
  file?: { name?: string; mimeType?: string; bytes?: string; uri?: string };
}

interface LogDetail {
  id: number;
  data?: {
    payload?: {
      event?: string;
      task?: { text?: string };
      parts?: A2APart[];
    };
  };
  // Some servers embed payload directly
  payload?: {
    event?: string;
    task?: { text?: string };
    parts?: A2APart[];
  };
}

// ---------------------------------------------------------------------------
// WebhookPoller — public facade; routes to HTTP polling or WebSocket
// ---------------------------------------------------------------------------

export class WebhookPoller {
  private readonly _impl: HttpWebhookPoller | WebSocketPoller;

  constructor(baseUrl: string, apiKey: string, slug: string) {
    const isWs = baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://');
    this._impl = isWs
      ? new WebSocketPoller(baseUrl, apiKey, slug)
      : new HttpWebhookPoller(baseUrl, apiKey, slug);
  }

  /** Start the WebSocket connection (no-op for HTTP pollers). */
  start(todoPath: string, log?: (msg: string) => void, workspaceRoot?: string): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.start(todoPath, log, workspaceRoot);
    }
  }

  /** Tear down any persistent connections. */
  destroy(): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.destroy();
    }
  }

  /**
   * Poll once for the next pending task and append it to TODO.md.
   * For WebSocket mode: always returns false (tasks arrive via push).
   */
  pollAndAppend(todoPath: string, workspaceRoot?: string): Promise<boolean> {
    return this._impl.pollAndAppend(todoPath, workspaceRoot);
  }

  /**
   * Send a JSON frame to the server over the WebSocket connection.
   * No-op (returns false) in HTTP polling mode or when disconnected.
   */
  sendFrame(payload: unknown): boolean {
    if (this._impl instanceof WebSocketPoller) {
      return this._impl.sendFrame(payload);
    }
    return false;
  }

  /** Pass the VNC password to use when a vnc_session start arrives. */
  setVncPassword(password?: string): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setVncPassword(password);
    }
  }

  setGitEnabled(enabled: boolean): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setGitEnabled(enabled);
    }
  }

  setRdpSettings(s: { host?: string; port?: number; username?: string; password?: string; domain?: string; guacWsUrl?: string }): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setRdpSettings(s);
    }
  }

  /** Register a callback to fire each time the WS connection is established. */
  setOnConnect(cb: () => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnConnect(cb);
    }
  }

  /** Register a callback to fire each time a WS-pushed task is appended to TODO.md. */
  setOnTaskAppend(cb: () => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnTaskAppend(cb);
    }
  }

  setOnCommand(cb: (cmd: string) => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnCommand(cb);
    } else {
      (this._impl as HttpWebhookPoller).setOnCommand(cb);
    }
  }

  setOnMcpUpdate(cb: (entries: Record<string, unknown>) => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnMcpUpdate(cb);
    }
  }

  setOnExportRequest(cb: (agentId: string) => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnExportRequest(cb);
    }
  }

  setOnRestoreRequest(cb: (agentId: string, downloadUrl: string) => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnRestoreRequest(cb);
    }
  }

  setOnExportConfig(cb: (exportEnabled: boolean, exportDailyBackup: boolean, agentId: string) => void): void {
    if (this._impl instanceof WebSocketPoller) {
      this._impl.setOnExportConfig(cb);
    }
  }

  /** True when backed by a WebSocket connection (vs HTTP polling). */
  get isWebSocket(): boolean {
    return this._impl instanceof WebSocketPoller;
  }
}

// ---------------------------------------------------------------------------
// HttpWebhookPoller — original HTTP-polling implementation
// ---------------------------------------------------------------------------

class HttpWebhookPoller {
  private lastProcessedId = 0;
  private _etag: string | undefined;
  private _polling = false;
  private _lastPollTime = 0;
  private _onCommand: ((cmd: string) => void) | null = null;
  private static readonly MIN_INTERVAL_MS = 3_000;

  setOnCommand(cb: (cmd: string) => void): void { this._onCommand = cb; }

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly slug: string,
  ) {}

  /**
   * Poll once for the next pending task and append it to TODO.md.
   * Returns true if a task was appended; false otherwise.
   * Skips if a previous poll is still in-flight, or if minimum interval hasn't elapsed.
   */
  async pollAndAppend(todoPath: string, workspaceRoot?: string): Promise<boolean> {
    // Skip if a previous request is still in progress
    if (this._polling) { return false; }

    // Enforce minimum 3-second gap between requests
    const elapsed = Date.now() - this._lastPollTime;
    if (this._lastPollTime > 0 && elapsed < HttpWebhookPoller.MIN_INTERVAL_MS) { return false; }

    this._polling = true;
    this._lastPollTime = Date.now();
    try {
      const qs = new URLSearchParams({
        status: 'pending',
        per_page: '1',
        endpoint_slug: this.slug,
      }).toString();

      const { data: listData, etag, notModified } = await this._getWithEtag<{ data?: LogListItem[] } | LogListItem[]>(
        `/v1/logs?${qs}`,
      );

      // Server says nothing changed — skip processing
      if (notModified) { return false; }

      // Store ETag for next request
      if (etag) { this._etag = etag; }

      // Handle both wrapped { data: [...] } and bare [...] responses
      const logs: LogListItem[] = Array.isArray(listData)
        ? listData
        : (listData as { data?: LogListItem[] }).data ?? [];

      if (logs.length === 0) { return false; }

      const log = logs[0];
      const logId = log.id;
      if (!logId || logId <= this.lastProcessedId) { return false; }

      const detail = await this._get<LogDetail>(`/v1/logs/${logId}`);

      // Mark received immediately regardless of outcome (don't re-deliver)
      this.lastProcessedId = logId;
      this._patch(`/v1/logs/${logId}`, { status: 'received' }).catch(() => {});

      // Extract payload — try both nesting styles
      const payload = detail.data?.payload ?? detail.payload;
      if (!payload || payload.event !== 'user_message') { return false; }

      let taskText = payload.task?.text ?? '';
      // Pre-generate task ID so attachments share the same prefix
      const httpTaskId = shortId();
      const textParts: string[] = [];
      const attRefs: string[] = [];
      if (payload.parts && workspaceRoot) {
        for (const part of payload.parts) {
          if (part.kind === 'text') {
            const t = part.text ?? '';
            if (t) { textParts.push(t); }
          } else if (part.kind === 'file' && part.file) {
            const name = part.file.name ?? 'attachment';
            const bytesB64 = part.file.bytes;
            if (bytesB64) {
              const buf = Buffer.from(bytesB64, 'base64');
              const rel = saveAttachment(workspaceRoot, name, buf, httpTaskId);
              attRefs.push(rel);
            } else if (part.file.uri) {
              attRefs.push(part.file.uri);
            }
          }
        }
      }
      // Use parts text only as fallback when task.text is absent
      if (!taskText && textParts.length > 0) { taskText = textParts.join(' '); }
      if (!taskText) { return false; }
      // Collapse newlines so the entire message becomes a single TODO.md line
      taskText = taskText.replace(/\r\n|\r|\n/g, ' ').trim();

      // Handle slash commands — don't append as tasks
      if (taskText.startsWith('/')) {
        this._onCommand?.(taskText);
        return false;
      }

      const fullText = attRefs.length > 0
        ? taskText + ' ' + attRefs.map(p => `[attachment: ${p}]`).join(' ')
        : taskText;

      await todoWriter.append(todoPath, fullText, httpTaskId);
      return true;
    } catch {
      return false;
    } finally {
      this._polling = false;
    }
  }

  // ---------------------------------------------------------------------------

  private _getWithEtag<T>(path: string): Promise<{ data: T; etag?: string; notModified: boolean }> {
    return jsonRequestWithEtag('GET', this.baseUrl, path, this.apiKey, this._etag);
  }

  private _get<T>(path: string): Promise<T> {
    return jsonRequest('GET', this.baseUrl, path, this.apiKey, undefined);
  }

  private _patch(path: string, body: unknown): Promise<unknown> {
    return jsonRequest('PATCH', this.baseUrl, path, this.apiKey, body);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequestWithEtag<T>(
  method: string,
  baseUrl: string,
  path: string,
  apiKey: string,
  etag: string | undefined,
): Promise<{ data: T; etag?: string; notModified: boolean }> {
  return new Promise((resolve, reject) => {
    const rawUrl = baseUrl.replace(/\/$/, '') + path;
    const parsed = url.parse(rawUrl);

    const headers: Record<string, string> = {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
      'User-Agent': 'AutoDev-VSCode/1.0',
    };
    if (etag) { headers['If-None-Match'] = etag; }

    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method,
      headers,
    };

    const transport = rawUrl.startsWith('https') ? https : http;
    const req = transport.request(options, (res: import('http').IncomingMessage) => {
      if (res.statusCode === 304) {
        resolve({ data: {} as T, etag, notModified: true });
        return;
      }
      const responseEtag = res.headers['etag'] as string | undefined;
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (!data.trim()) { resolve({ data: {} as T, etag: responseEtag, notModified: false }); return; }
        try { resolve({ data: JSON.parse(data) as T, etag: responseEtag, notModified: false }); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

function jsonRequest<T>(
  method: string,
  baseUrl: string,
  path: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const rawUrl = baseUrl.replace(/\/$/, '') + path;
    const parsed = url.parse(rawUrl);
    const json = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
      'User-Agent': 'AutoDev-VSCode/1.0',
    };
    if (json) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(json));
    }

    const options: http.RequestOptions = {
      hostname: parsed.hostname ?? '',
      port: parsed.port,
      path: parsed.path ?? '/',
      method,
      headers,
    };

    const transport = rawUrl.startsWith('https') ? https : http;
    const req = transport.request(options, (res: import('http').IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (!data.trim()) { resolve({} as T); return; }
        try { resolve(JSON.parse(data) as T); } catch { reject(new Error('Invalid JSON')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('Request timed out')); });
    if (json) { req.write(json); }
    req.end();
  });
}
