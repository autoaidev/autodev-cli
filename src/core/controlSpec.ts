import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// .autodev/CONTROL.md — opt-in "keep-on-green" control spec.
//
// Ported from autoresearch's program.md into a machine-readable form. When a
// workspace ships a `.autodev/CONTROL.md` (or `.autodev/control.yml`) the task
// loop gains a verify_and_keep gate: after each task it runs `verify`, keeps
// the change only when it passes (green), and reverts on exhaustion.
//
// ABSENT FILE ⇒ loadControlSpec() returns null and the loop behaves EXACTLY as
// it does today (byte-for-byte). Every new loop path is guarded on this spec.
// ---------------------------------------------------------------------------

export interface ControlSpec {
  /** Verify command(s) run after each task. GREEN (all exit 0) => keep. Empty => gate disabled. */
  verify: string[];
  /** Globs that must never be part of a kept edit. A task touching one is reverted. */
  protected_files: string[];
  /** What condition counts as "keep" — reserved; currently only 'green'. */
  keep_on: string;
  /** Max fix re-dispatches on a red verify before the change is discarded+reverted. */
  max_fix_rounds: number;
  /** Cheap auto-fix passes allowed for mechanical failures (type/import/syntax) before counting a real fix round. */
  max_mechanical_fixes: number;
  /** Hard wall-clock budget per task; exceeding it discards+reverts. null => no budget. */
  budget_seconds: number | null;
  /** Free-form conditions under which the agent should escalate instead of silently continuing. */
  escalate_when: string[];
  /** Free-form policy describing what to do when fix rounds are exhausted. */
  exhaustion: string;
}

/** A spec with the verify gate active (verify has at least one command). */
export function isGateActive(spec: ControlSpec | null | undefined): spec is ControlSpec {
  return !!spec && Array.isArray(spec.verify) && spec.verify.length > 0;
}

function asStringArray(v: unknown): string[] {
  if (v == null) { return []; }
  if (Array.isArray(v)) { return v.map(x => String(x).trim()).filter(Boolean); }
  const s = String(v).trim();
  return s ? [s] : [];
}

/**
 * Extremely small YAML subset parser — enough for CONTROL.md.
 * Supports: `key: scalar`, `key: [a, b]`, and a `key:` header followed by
 * indented `- item` list lines. One level of nesting only. Comments (`#`) and
 * blank lines are ignored. Quotes are stripped from scalars.
 */
export function parseControlYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let listKey: string | null = null;
  let listAcc: string[] = [];
  const flushList = () => {
    if (listKey !== null) { out[listKey] = listAcc; listKey = null; listAcc = []; }
  };
  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, ''); // strip trailing comments
    if (!line.trim()) { continue; }
    if (line.trim().startsWith('#')) { continue; }
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey !== null) {
      listAcc.push(stripQuotes(listItem[1]));
      continue;
    }
    const kv = line.match(/^(\S[^:]*?):\s*(.*)$/);
    if (kv) {
      flushList();
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '') {
        // Could be the header of an indented list — start accumulating.
        listKey = key;
        listAcc = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        out[key] = val.slice(1, -1).split(',').map(s => stripQuotes(s)).filter(Boolean);
      } else {
        out[key] = stripQuotes(val);
      }
    }
  }
  flushList();
  // A key that opened a list but got no items is an empty list.
  return out;
}

function specFromRaw(raw: Record<string, unknown>): ControlSpec {
  const num = (v: unknown, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const budgetRaw = raw['budget_seconds'];
  const budget = budgetRaw == null || budgetRaw === '' ? null : num(budgetRaw, 0) || null;
  return {
    verify: asStringArray(raw['verify']),
    protected_files: asStringArray(raw['protected_files'] ?? raw['protected']),
    keep_on: (typeof raw['keep_on'] === 'string' && raw['keep_on']) ? String(raw['keep_on']) : 'green',
    max_fix_rounds: num(raw['max_fix_rounds'], 3),
    max_mechanical_fixes: num(raw['max_mechanical_fixes'], 1),
    budget_seconds: budget,
    escalate_when: asStringArray(raw['escalate_when']),
    exhaustion: typeof raw['exhaustion'] === 'string' ? String(raw['exhaustion']) : '',
  };
}

/**
 * Load the control spec for a workspace, or null if none exists.
 * Reads `.autodev/CONTROL.md` (first ```yaml fenced block) or `.autodev/control.yml`.
 * Returns null on absence or parse failure — the caller then behaves as today.
 */
export function loadControlSpec(root: string): ControlSpec | null {
  try {
    const dir = path.join(root, '.autodev');
    const ymlPath = path.join(dir, 'control.yml');
    const mdPath = path.join(dir, 'CONTROL.md');
    let yamlText: string | null = null;
    if (fs.existsSync(ymlPath)) {
      yamlText = fs.readFileSync(ymlPath, 'utf8');
    } else if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf8');
      const fence = md.match(/```ya?ml\s*\n([\s\S]*?)```/i);
      // Fall back to the whole file if the doc is written as bare YAML with no fence.
      yamlText = fence ? fence[1] : md;
    }
    if (yamlText == null) { return null; }
    const raw = parseControlYaml(yamlText);
    const spec = specFromRaw(raw);
    // A CONTROL file that parses to nothing meaningful is treated as present-but-empty,
    // NOT as a gate — verify is empty, so isGateActive() is false and the loop still
    // behaves as today. We still return the spec so protected_files/budget could apply
    // if the user set only those, but with no verify the gate itself stays off.
    return spec;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verify execution + helpers (used by the verify_and_keep gate in taskLoop).
// ---------------------------------------------------------------------------

export interface VerifyResult {
  /** All configured commands exited 0. */
  ok: boolean;
  /** Combined tail of stdout/stderr across commands (capped). */
  output: string;
  /** Exit code of the first failing command, or 0 if all passed. */
  code: number;
  /** True when the run was killed by the timeout. */
  timedOut: boolean;
}

/**
 * Run each verify command in sequence. GREEN only when every command exits 0.
 * Captures combined output (tail-capped) for the fix hint and journal notes.
 */
export function runVerify(commands: string[], cwd: string, timeoutMs: number): VerifyResult {
  let output = '';
  for (const cmd of commands) {
    let r;
    try {
      r = spawnSync(cmd, {
        cwd,
        shell: true,
        encoding: 'utf8',
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      return { ok: false, output: `${output}\n$ ${cmd}\n${e instanceof Error ? e.message : String(e)}`.trim(), code: 1, timedOut: false };
    }
    const chunk = `$ ${cmd}\n${(r.stdout || '')}${(r.stderr || '')}`;
    output = (output ? output + '\n' : '') + chunk;
    const timedOut = (r as { signal?: string }).signal === 'SIGTERM' && r.status == null;
    if (r.status !== 0) {
      const capped = output.length > 6000 ? '…' + output.slice(-6000) : output;
      return { ok: false, output: capped, code: r.status ?? 1, timedOut };
    }
  }
  const capped = output.length > 6000 ? '…' + output.slice(-6000) : output;
  return { ok: true, output: capped, code: 0, timedOut: false };
}

/**
 * Does a failure output look MECHANICAL (a cheap, local fix — type error, missing
 * import, syntax error) rather than a genuine logic failure? Used to grant a cheap
 * extra auto-fix pass before counting a real fix round.
 */
export function isMechanicalFailure(output: string): boolean {
  const s = output.toLowerCase();
  return (
    /error ts\d+/.test(s) ||                         // tsc: error TS2304
    s.includes('cannot find name') ||
    s.includes('cannot find module') ||
    s.includes('is not defined') ||
    s.includes('has no exported member') ||
    s.includes('syntaxerror') ||
    s.includes('unexpected token') ||
    s.includes('unexpected identifier') ||
    s.includes('missing import') ||
    s.includes('no such file or directory') ||
    s.includes('importerror') ||
    s.includes('modulenotfounderror')
  );
}

/** Convert a simple glob (supporting **, *, ?) to a RegExp anchored to the whole path. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') { i++; } }
      else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]';
    } else if ('.^$+{}()|[]\\'.includes(c)) { re += '\\' + c;
    } else { re += c; }
  }
  return new RegExp('^' + re + '$');
}

/** True when `file` (repo-relative, forward slashes) matches any of the globs. */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some(g => {
    const gg = g.replace(/^\.\//, '');
    if (globToRegExp(gg).test(norm)) { return true; }
    // A bare filename glob (no slash) should also match a basename anywhere.
    if (!gg.includes('/') && globToRegExp(gg).test(norm.split('/').pop() || norm)) { return true; }
    return false;
  });
}

