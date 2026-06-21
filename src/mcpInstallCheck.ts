// ---------------------------------------------------------------------------
// mcpInstallCheck — async detection of whether each MCP server's runner +
// package are installed. Results are cached in-memory.
//
// Important: spawnSync would block the extension host on activation (4 builtins
// × 3 child processes each), which makes the webview fail to register its
// service worker ("document is in an invalid state"). All probes are async;
// _push() reads whatever's already cached, and refreshMcpInstall() kicks off
// the spawns in the background and resolves when the snapshot is fresh.
// ---------------------------------------------------------------------------

import { spawn } from 'child_process';

export type McpInstallStatus = 'installed' | 'missing-runner' | 'missing-package' | 'unknown';

export interface McpInstallInfo {
  status: McpInstallStatus;
  runner: string;
  pkg?: string;
}

interface CheckTarget {
  command: string;
  args: string[];
}

const _runnerCache = new Map<string, boolean>();
const _pkgCache = new Map<string, boolean>(); // key = `${runner}:${pkg}`

export function invalidateMcpInstallCache(): void {
  _runnerCache.clear();
  _pkgCache.clear();
}

function _runProbe(cmd: string, args: string[], timeoutMs: number, useShell: boolean): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let proc;
    try {
      proc = spawn(cmd, args, { shell: useShell, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ code: -1, stdout });
    }, timeoutMs);
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (c: string) => { stdout += c; });
    proc.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout: '' }); } });
    proc.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout }); } });
  });
}

async function _hasOnPath(cmd: string): Promise<boolean> {
  if (_runnerCache.has(cmd)) return _runnerCache.get(cmd)!;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const { code, stdout } = await _runProbe(which, [cmd], 4000, false);
  const ok = code === 0 && !!stdout.trim();
  _runnerCache.set(cmd, ok);
  return ok;
}

function _bareNpmPkg(spec: string): string {
  if (spec.startsWith('@')) {
    const i = spec.indexOf('/');
    if (i < 0) return spec;
    const tail = spec.slice(i + 1);
    const at = tail.indexOf('@');
    return at < 0 ? spec : spec.slice(0, i + 1) + tail.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at < 0 ? spec : spec.slice(0, at);
}

function _bareUvPkg(spec: string): string {
  return spec.split(/[=@<>!~]/, 1)[0]!;
}

function _firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (a === '--from' || a === '--with' || a === '--python') i++;
      continue;
    }
    return a;
  }
  return undefined;
}

async function _hasNpmGlobal(pkg: string): Promise<boolean> {
  const key = `npm:${pkg}`;
  if (_pkgCache.has(key)) return _pkgCache.get(key)!;
  const { code, stdout } = await _runProbe('npm', ['ls', '-g', '--depth=0', '--json', pkg], 8000, true);
  let ok = false;
  if (code === 0 && stdout) {
    try {
      const out = JSON.parse(stdout) as { dependencies?: Record<string, unknown> };
      ok = !!(out.dependencies && out.dependencies[pkg]);
    } catch { ok = false; }
  }
  _pkgCache.set(key, ok);
  return ok;
}

async function _hasUvTool(pkg: string): Promise<boolean> {
  const key = `uv:${pkg.toLowerCase()}`;
  if (_pkgCache.has(key)) return _pkgCache.get(key)!;
  const { code, stdout } = await _runProbe('uv', ['tool', 'list'], 6000, true);
  let ok = false;
  if (code === 0 && stdout) {
    const lines = stdout.toLowerCase().split(/\r?\n/);
    ok = lines.some(l => l.split(/\s+/)[0] === pkg.toLowerCase());
  }
  _pkgCache.set(key, ok);
  return ok;
}

/** Read-only cached lookup. Never spawns. Returns 'unknown' if not yet probed. */
export function getMcpInstallSnapshot(target: CheckTarget): McpInstallInfo {
  const runner = target.command || '';
  if (!runner) return { status: 'unknown', runner: '' };
  if (!_runnerCache.has(runner)) return { status: 'unknown', runner };
  if (!_runnerCache.get(runner)) return { status: 'missing-runner', runner };

  const arg = _firstPositional(target.args || []);
  if (runner === 'npx') {
    if (!arg) return { status: 'installed', runner };
    // If -y flag is present npx auto-fetches — no global install needed.
    if ((target.args || []).includes('-y')) {
      const pkg = _bareNpmPkg(arg);
      return { status: _runnerCache.get(runner) ? 'installed' : 'missing-runner', runner, pkg };
    }
    const pkg = _bareNpmPkg(arg);
    const key = `npm:${pkg}`;
    if (!_pkgCache.has(key)) return { status: 'unknown', runner, pkg };
    return { status: _pkgCache.get(key) ? 'installed' : 'missing-package', runner, pkg };
  }
  if (runner === 'uvx') {
    // uvx auto-fetches packages on demand (like npx). If uvx is on PATH,
    // treat the package as installed — `uv tool list` only shows packages
    // installed via `uv tool install`, which uvx does not require.
    const pkg = arg ? _bareUvPkg(arg) : undefined;
    return { status: 'installed', runner, pkg };
  }
  return { status: 'installed', runner, pkg: arg };
}

/** Async probe of a single target. Populates cache and returns the result. */
export async function checkMcpInstallAsync(target: CheckTarget): Promise<McpInstallInfo> {
  const runner = target.command || '';
  if (!runner) return { status: 'unknown', runner: '' };
  if (!(await _hasOnPath(runner))) return { status: 'missing-runner', runner };

  const arg = _firstPositional(target.args || []);
  if (runner === 'npx') {
    if (!arg) return { status: 'installed', runner };
    // If -y flag is present npx auto-fetches the package — no global install needed.
    if ((target.args || []).includes('-y')) {
      const pkg = _bareNpmPkg(arg);
      return { status: 'installed', runner, pkg };
    }
    const pkg = _bareNpmPkg(arg);
    return { status: (await _hasNpmGlobal(pkg)) ? 'installed' : 'missing-package', runner, pkg };
  }
  if (runner === 'uvx') {
    // uvx auto-fetches on demand — runner present is enough.
    const pkg = arg ? _bareUvPkg(arg) : undefined;
    return { status: 'installed', runner, pkg };
  }
  return { status: 'installed', runner, pkg: arg };
}

/**
 * Probe every target sequentially, populating the cache. Resolves once all
 * probes have either returned or timed out. Sequential (not parallel) to
 * avoid spawn-storms that can starve the extension host on activation.
 */
export async function refreshMcpInstall(targets: CheckTarget[]): Promise<void> {
  for (const t of targets) {
    try { await checkMcpInstallAsync(t); } catch { /* ignore */ }
  }
}

export function installCommandFor(info: McpInstallInfo): string | null {
  if (info.status === 'installed' || info.status === 'unknown') return null;
  if (info.status === 'missing-runner') {
    if (info.runner === 'uvx' || info.runner === 'uv') {
      return process.platform === 'win32'
        ? 'powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : 'curl -LsSf https://astral.sh/uv/install.sh | sh';
    }
    return null;
  }
  if (!info.pkg) return null;
  if (info.runner === 'npx') return `npm install -g ${info.pkg}`;
  if (info.runner === 'uvx') return `uv tool install ${info.pkg}`;
  return null;
}
