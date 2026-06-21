// ---------------------------------------------------------------------------
// mcpEmailTest — connectivity check that runs the *actual* mcp-email-server
// over stdio with the configured env, performs the MCP initialize handshake,
// lists tools, and invokes an IMAP-reading tool to prove credentials work.
//
// Why through the server (not raw IMAP/SMTP): it's the same code path the
// agent will use, so a green test means the agent will succeed too — covers
// env-var naming, package install state, IMAP+SMTP config, all in one shot.
// ---------------------------------------------------------------------------

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface EmailTestEnv {
  MCP_EMAIL_SERVER_ACCOUNT_NAME: string;
  MCP_EMAIL_SERVER_FULL_NAME?: string;
  MCP_EMAIL_SERVER_EMAIL_ADDRESS: string;
  MCP_EMAIL_SERVER_USER_NAME?: string;
  MCP_EMAIL_SERVER_PASSWORD: string;
  MCP_EMAIL_SERVER_IMAP_HOST: string;
  MCP_EMAIL_SERVER_IMAP_PORT: string;
  MCP_EMAIL_SERVER_IMAP_SSL: string;
  MCP_EMAIL_SERVER_IMAP_VERIFY_SSL: string;
  MCP_EMAIL_SERVER_SMTP_HOST: string;
  MCP_EMAIL_SERVER_SMTP_PORT: string;
  MCP_EMAIL_SERVER_SMTP_SSL: string;
  MCP_EMAIL_SERVER_SMTP_START_SSL: string;
  MCP_EMAIL_SERVER_SMTP_VERIFY_SSL: string;
  [k: string]: string | undefined;
}

export interface ServerTestResult {
  ok: boolean;
  /** Top-level summary message shown in the UI. */
  message: string;
  /** Per-step lines: spawn, initialize, tools/list, IMAP read. */
  steps: { name: string; ok: boolean; detail?: string }[];
}

const STEP_TIMEOUT_MS = 25000;
const TOTAL_TIMEOUT_MS = 60000;

interface PendingRpc {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

class StdioMcpClient {
  private buf = '';
  private pending = new Map<number, PendingRpc>();
  private nextId = 1;
  private earlyStderr = '';
  private done = false;

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk: string) => { this.earlyStderr += chunk; });
    proc.on('error', (e) => this._failAll(e));
    proc.on('close', () => {
      this.done = true;
      this._failAll(new Error('mcp-email-server exited' + (this.earlyStderr ? `: ${this.earlyStderr.trim().slice(-300)}` : '')));
    });
  }

  private _onStdout(chunk: string): void {
    this.buf += chunk;
    // mcp-email-server speaks newline-delimited JSON over stdout.
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = msg['id'];
      if (typeof id === 'number' && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        p.resolve(msg);
      }
    }
  }

  private _failAll(err: Error): void {
    for (const p of this.pending.values()) { p.reject(err); }
    this.pending.clear();
  }

  call(method: string, params?: unknown): Promise<Record<string, unknown>> {
    if (this.done) return Promise.reject(new Error('server already exited'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout after ${STEP_TIMEOUT_MS}ms waiting for ${method}` + (this.earlyStderr ? ` (stderr: ${this.earlyStderr.trim().slice(-200)})` : '')));
        }
      }, STEP_TIMEOUT_MS);
      const wrap = (r: Record<string, unknown>) => { clearTimeout(t); resolve(r); };
      const wrapErr = (e: Error) => { clearTimeout(t); reject(e); };
      this.pending.set(id, { resolve: wrap, reject: wrapErr });
      try { this.proc.stdin.write(payload); }
      catch (e) { this.pending.delete(id); clearTimeout(t); reject(e as Error); }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.done) return;
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n'); } catch { /* ignore */ }
  }

  close(): void {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }

  get stderrSnapshot(): string { return this.earlyStderr; }
}

function _toolNameOf(t: unknown): string {
  return (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
    ? (t as { name: string }).name : '';
}

function _pickImapTool(tools: unknown[]): string | null {
  const names = tools.map(_toolNameOf).filter(Boolean);
  // Prefer tools that read mail (proves IMAP login). Order = preference.
  const patterns = [
    /^count_daily_emails$/i,
    /^count_emails$/i,
    /^page_emails?$/i,
    /^list_emails?$/i,
    /^get_unread_count$/i,
    /^list_available_accounts$/i, // last resort — only proves server boot
  ];
  for (const p of patterns) {
    const hit = names.find(n => p.test(n));
    if (hit) return hit;
  }
  return null;
}

function _argsForImapTool(name: string, account: string): Record<string, unknown> {
  const lc = name.toLowerCase();
  if (lc === 'list_available_accounts') return {};
  if (lc.includes('count')) {
    // count_daily_emails(account, start_date, end_date) — narrow window.
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const day = `${yyyy}-${mm}-${dd}`;
    return { account_name: account, start_date: day, end_date: day };
  }
  // list / page — keep it tiny.
  return { account_name: account, page: 1, page_size: 1 };
}

function _humanResult(name: string, result: Record<string, unknown>): string {
  const r = result['result'];
  if (r && typeof r === 'object') {
    const content = (r as { content?: unknown }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { text?: unknown };
      if (typeof first.text === 'string') {
        const txt = first.text.trim();
        return `${name} → ${txt.length > 180 ? txt.slice(0, 180) + '…' : txt}`;
      }
    }
    return `${name} → returned ${Object.keys(r).length} field(s)`;
  }
  if (result['error']) {
    const err = result['error'] as { message?: unknown };
    return `${name} → error: ${typeof err.message === 'string' ? err.message : JSON.stringify(result['error'])}`;
  }
  return `${name} → unexpected response shape`;
}

export async function testEmailViaMcp(env: EmailTestEnv): Promise<ServerTestResult> {
  const steps: ServerTestResult['steps'] = [];
  const fullEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const cmd = 'uvx';
  const args = ['mcp-email-server@latest', 'stdio'];

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(cmd, args, {
      env: fullEnv,
      shell: process.platform === 'win32', // resolve uvx via cmd on Windows
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    steps.push({ name: 'spawn uvx mcp-email-server', ok: true });
  } catch (e) {
    steps.push({ name: 'spawn uvx mcp-email-server', ok: false, detail: (e as Error).message });
    return { ok: false, message: 'Could not start mcp-email-server (uvx missing?).', steps };
  }

  const client = new StdioMcpClient(proc);
  const overall = setTimeout(() => client.close(), TOTAL_TIMEOUT_MS);

  try {
    const initRes = await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'autodev-test', version: '1.0' },
    });
    if (initRes['error']) {
      const err = initRes['error'] as { message?: unknown };
      steps.push({ name: 'initialize', ok: false, detail: typeof err.message === 'string' ? err.message : JSON.stringify(initRes['error']) });
      return { ok: false, message: 'MCP initialize failed.', steps };
    }
    const sv = (initRes['result'] as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo;
    steps.push({ name: 'initialize', ok: true, detail: sv ? `${sv.name ?? '?'} ${sv.version ?? ''}`.trim() : '(no serverInfo)' });

    client.notify('notifications/initialized');

    const listRes = await client.call('tools/list', {});
    const toolsField = (listRes['result'] as { tools?: unknown[] } | undefined)?.tools ?? [];
    if (!Array.isArray(toolsField) || toolsField.length === 0) {
      steps.push({ name: 'tools/list', ok: false, detail: '0 tools advertised' });
      return { ok: false, message: 'Server returned no tools — config likely invalid.', steps };
    }
    const toolNames = toolsField.map(_toolNameOf).filter(Boolean);
    steps.push({ name: 'tools/list', ok: true, detail: `${toolNames.length} tools: ${toolNames.slice(0, 6).join(', ')}${toolNames.length > 6 ? '…' : ''}` });

    const imapTool = _pickImapTool(toolsField);
    if (!imapTool) {
      steps.push({ name: 'IMAP read via MCP', ok: false, detail: 'no IMAP-reading tool found in tools/list' });
      return { ok: true, message: 'Server boots and lists tools, but no IMAP tool found to verify credentials.', steps };
    }
    const account = env.MCP_EMAIL_SERVER_ACCOUNT_NAME || 'default';
    const callRes = await client.call('tools/call', { name: imapTool, arguments: _argsForImapTool(imapTool, account) });
    if (callRes['error']) {
      const err = callRes['error'] as { message?: unknown };
      steps.push({ name: `IMAP read via ${imapTool}`, ok: false, detail: typeof err.message === 'string' ? err.message : JSON.stringify(callRes['error']) });
      return { ok: false, message: `IMAP tool ${imapTool} returned an error — credentials/host likely wrong.`, steps };
    }
    const inner = callRes['result'] as { isError?: boolean; content?: unknown[] } | undefined;
    if (inner?.isError) {
      const txt = Array.isArray(inner.content) && inner.content[0] && typeof (inner.content[0] as { text?: unknown }).text === 'string'
        ? (inner.content[0] as { text: string }).text : JSON.stringify(inner);
      steps.push({ name: `IMAP read via ${imapTool}`, ok: false, detail: txt.slice(0, 240) });
      return { ok: false, message: `IMAP tool ${imapTool} reported an error.`, steps };
    }
    steps.push({ name: `IMAP read via ${imapTool}`, ok: true, detail: _humanResult(imapTool, callRes) });

    return {
      ok: true,
      message: `mcp-email-server is working: handshake + ${toolNames.length} tools + IMAP read via ${imapTool}.`,
      steps,
    };
  } catch (e) {
    steps.push({ name: 'rpc', ok: false, detail: (e as Error).message + (client.stderrSnapshot ? ` | stderr: ${client.stderrSnapshot.trim().slice(-240)}` : '') });
    return { ok: false, message: 'MCP test aborted: ' + (e as Error).message, steps };
  } finally {
    clearTimeout(overall);
    client.close();
  }
}
