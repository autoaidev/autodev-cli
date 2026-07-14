// Shared builder for the raw HTTP/1.1 WebSocket upgrade request used by the
// hand-rolled WS clients (webSocketPoller + officeSocket — this repo has no
// `ws` dependency).
//
// Security note: pixel-office historically minted the wsUrl with the agent
// api_key embedded as a `?token=…` (a.k.a. `?key=`) query param, which leaks
// the secret into logs/proxies/referrers. Newer pixel-office ALSO reads the key
// from an `X-Agent-Key` request header on the WS upgrade. We therefore send the
// key BOTH ways: the header is preferred (kept out of URLs), while the existing
// query param in `upgradePath` is left intact so this stays compatible with an
// older pixel-office that only reads the query string.

export interface WsUpgradeRequestOpts {
  /** Path + query string, e.g. `/ws?token=…&endpoint=…` (query param key kept for old servers). */
  upgradePath: string;
  host: string;
  port: number;
  /** Randomly generated Sec-WebSocket-Key (base64). */
  secWebSocketKey: string;
  /** Agent api_key — additionally sent as the X-Agent-Key header (preferred). */
  agentKey?: string;
}

/** Build the raw `GET … HTTP/1.1` WebSocket upgrade request string (CRLF-terminated). */
export function buildWsUpgradeRequest(opts: WsUpgradeRequestOpts): string {
  const lines = [
    `GET ${opts.upgradePath} HTTP/1.1`,
    `Host: ${opts.host}:${opts.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${opts.secWebSocketKey}`,
    'Sec-WebSocket-Version: 13',
  ];
  // Prefer the header; keep the query-param behaviour (in upgradePath) working too.
  if (opts.agentKey) { lines.push(`X-Agent-Key: ${opts.agentKey}`); }
  lines.push('', '');
  return lines.join('\r\n');
}
