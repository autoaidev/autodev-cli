// ---------------------------------------------------------------------------
// grok leader KEEPALIVE client (Layer B, 1.4.193).
//
// A tiny leader-client that holds ONE session warm in the leader's memory forever
// so loop clients can attach-without-load across restarts (grok 1.0.41 evicts a
// session's in-memory context when its LAST client disconnects). Deliberately
// depends on ONLY node:fs + node:child_process — NO commander, NO provider graph —
// so the DETACHED process starts fast and can't fail to load a missing dep. Run via
// the minimal `keepaliveMain` entry, spawned detached by `ensureLeader`.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as child_process from 'child_process';

export interface RunKeepaliveOpts {
  socket: string;
  cwd: string;
  sidFile: string;
  bin: string;
  seed?: string;
}

/**
 * Connect to the leader as a client, establish ONE session (session/load the seed
 * id if given, else session/new), write the session id to `sidFile`, then HOLD the
 * connection open indefinitely so the leader never evicts the in-memory context.
 * Exits when the leader dies (its stdout closes) so it never lingers as an orphan.
 * The returned promise never resolves (the caller keeps the process alive).
 */
export async function runKeepalive(opts: RunKeepaliveOpts): Promise<void> {
  const { socket, cwd, sidFile, bin, seed } = opts;
  const child = child_process.spawn(bin, ['agent', '--always-approve', '--leader', '--leader-socket', socket, 'stdio'], {
    cwd, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TERM: process.env['TERM'] || 'xterm-256color' },
  });
  let buf = '';
  let nextId = 1;
  const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: unknown }) => void>();
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) { continue; }
      let m: Record<string, unknown>;
      try { m = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = m['id'];
      if (typeof id === 'number' && (m['result'] !== undefined || m['error'] !== undefined) && pending.has(id)) {
        const r = pending.get(id)!; pending.delete(id); r(m as { result?: Record<string, unknown>; error?: unknown });
      } else if (m['method'] && id !== undefined) {
        // agent→client request: auto-allow so nothing wedges.
        const params = m['params'] as { options?: Array<{ optionId?: string; kind?: string }> } | undefined;
        const optsArr = params?.options ?? [];
        const allow = optsArr.find((o) => /allow|once|always/i.test(o.optionId || o.kind || '')) || optsArr[0];
        try { child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } }) + '\n'); } catch { /* ignore */ }
      }
    }
  });
  const req = (method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: unknown }> => new Promise((resolve) => {
    const id = nextId++; pending.set(id, resolve);
    try { child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch { pending.delete(id); resolve({ error: { message: 'write failed' } }); }
  });

  // When the leader (or this client) dies, exit so no orphan lingers.
  child.on('exit', () => { process.exit(0); });
  const bye = (): void => { try { child.kill('SIGKILL'); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);

  await req('initialize', { protocolVersion: 1, clientCapabilities: {} });
  let sid: string | undefined = seed;
  if (sid) {
    const r = await req('session/load', { sessionId: sid, cwd, mcpServers: [] });
    if ((r as { error?: unknown }).error) { sid = undefined; } // stale disk id → session/new
  }
  if (!sid) {
    const sn = await req('session/new', { cwd, mcpServers: [] });
    sid = (sn.result as { sessionId?: string } | undefined)?.sessionId;
  }
  if (!sid) { process.exit(1); }
  try { fs.writeFileSync(sidFile, sid, 'utf8'); } catch { /* ignore */ }
  // Hold the connection open forever — the whole point.
  await new Promise<void>(() => { /* never resolves; process lives until leader dies */ });
}
