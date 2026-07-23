// Secrets anonymizer for OUTBOUND agent content.
//
// Agent-originated content (tool calls/output, bash output, file reads,
// assistant prose) is forwarded from the CLI to the pixel-office, where it is
// STORED and DISPLAYED in the office feed/chat. Secrets (API keys, tokens) can
// leak into that stream. We redact them HERE, before the content leaves the
// machine — mirroring how the tutor project redacts its trace files.
//
// Scope: this is applied ONLY to outbound content going to the office (hook
// events, assistant narration, autonomy task results / A2A replies). It is NOT
// applied to the model's actual input, local files on disk, or the api_key used
// for auth (that travels as an HTTP header, not as content).
//
// Performance: the pattern list is compiled ONCE at module load (the const
// array below) and reused for every call. `redactSecrets` runs on every
// forwarded event, so we never rebuild RegExp objects per-call.
//
// Ordering: patterns run in array order — SPECIFIC shapes before GENERIC ones
// (e.g. `sk-ant-` before the generic `sk-` key, so an Anthropic key is labelled
// as such and its remainder can't be re-matched by a broader rule).
//
// The min-length bounds in each pattern are deliberate: they stop the generic
// rules from mangling ordinary prose. Do NOT loosen them.

interface RedactPattern {
  name: string;
  re: RegExp;      // MUST carry the global flag (we call String.replace with it)
  replacement: string;
}

// NOTE on emails: the reference trace-redactor also maps plain email addresses
// (PII). We DELIBERATELY do NOT redact emails here — user emails legitimately
// appear in the office UI (character owners, teammates), and redacting them
// would mangle normal content. So no email pattern is included.

const PATTERNS: readonly RedactPattern[] = [
  // Anthropic API keys — must run BEFORE the generic `sk-` rule.
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{15,}/g, replacement: 'sk-ant-REDACTED' },
  // Generic OpenAI-style `sk-…` keys.
  { name: 'openai_style_key', re: /sk-[A-Za-z0-9]{20,}/g, replacement: 'sk-REDACTED' },
  // GitHub tokens: gho_/ghp_/ghr_/ghs_/ghu_.
  { name: 'gh_token', re: /gh[oprsu]_[A-Za-z0-9]{20,}/g, replacement: 'gh_REDACTED' },
  // GitHub fine-grained PATs.
  { name: 'gh_pat', re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: 'github_pat_REDACTED' },
  // Google API keys.
  { name: 'google_api_key', re: /AIza[0-9A-Za-z_-]{25,}/g, replacement: 'AIza_REDACTED' },
  // Slack tokens: xoxb/xoxa/xoxp/xoxr/xoxs.
  { name: 'slack_token', re: /xox[baprs]-[0-9A-Za-z-]{20,}/g, replacement: 'xoxX-REDACTED' },
  // AWS access key IDs.
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA_REDACTED' },
  // Stripe secret/publishable/restricted live+test keys.
  { name: 'stripe_key', re: /(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g, replacement: 'stripe_REDACTED' },
  // JWTs (three base64url segments).
  { name: 'jwt_token', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: 'eyJ.REDACTED.JWT' },
  // `Bearer <token>` — keep the "Bearer " prefix, redact the credential.
  { name: 'bearer_token', re: /([Bb]earer\s+)[A-Za-z0-9._~+/=-]{20,}/g, replacement: '$1REDACTED_BEARER' },
  // PEM private-key blocks (RSA / EC / OPENSSH / generic).
  { name: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: '-----REDACTED_PRIVATE_KEY-----' },
  // JSON `"password": "…"` values.
  { name: 'password_json', re: /("[Pp]ass(?:word|wd)"\s*:\s*")[^"\\]+(")/g, replacement: '$1REDACTED$2' },
  // JSON `"token"/"auth_token"/"api_token"` values.
  { name: 'token_json', re: /("(?:[Aa]uth|[Aa]pi)?_?[Tt]oken"\s*:\s*")[^"\\]{15,}(")/g, replacement: '$1REDACTED$2' },
  // Shell/env `FOO_TOKEN=…`, `API_KEY: …`, `*_SECRET=…`, `*_PASSWORD=…`.
  { name: 'env_var_secret', re: /([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD)[A-Z0-9_]*\s*[:=]\s*["']?)[A-Za-z0-9/_+.=-]{15,}/g, replacement: '$1REDACTED' },
  // ── Our own pixel-office agent credential shapes ────────────────────────────
  // These are the office agent api_keys (`agt_…`) and personal access tokens
  // (`pat_…`). They authenticate a character to the office and must NEVER show
  // up in the office feed itself.
  { name: 'agt_key', re: /agt_[A-Za-z0-9]{16,}/g, replacement: 'agt_REDACTED' },
  { name: 'pat_key', re: /pat_[A-Za-z0-9]{16,}/g, replacement: 'pat_REDACTED' },
];

/**
 * Redact known secret shapes from a single string. Applies every pattern in
 * order (specific before generic). Returns the string unchanged when it holds
 * no secrets. Safe on empty / non-secret prose.
 */
export function redactSecrets(text: string): string {
  if (!text) { return text; }
  let out = text;
  for (const p of PATTERNS) {
    // `re` is a shared module-level RegExp with the global flag. String.replace
    // does not rely on / advance its lastIndex, so reuse is safe and allocation-
    // free (unlike RegExp.exec, which would need a lastIndex reset).
    out = out.replace(p.re, p.replacement);
  }
  return out;
}

/**
 * Deep-redact every STRING value inside an object/array, leaving structure and
 * KEYS intact. Hook events forwarded to the office are objects (not flat
 * strings) — their tool_input.command, tool_response, message text, etc. can
 * each carry a secret — so we walk the whole value and run `redactSecrets` on
 * every string leaf. Non-string leaves (numbers, booleans, null) pass through
 * untouched. Returns a NEW value; the input is not mutated.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
