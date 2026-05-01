import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export type IdeId = 'vscode' | 'cursor';

const IDE_INFO: Record<IdeId, { label: string; cmd: string; altCmds: string[]; extensionId: string }> = {
  vscode: {
    label: 'VS Code',
    cmd: 'code',
    altCmds: ['code-insiders'],
    extensionId: 'AutoAIDev.autoaidev',
  },
  cursor: {
    label: 'Cursor',
    cmd: 'cursor',
    altCmds: [],
    extensionId: 'AutoAIDev.autoaidev',
  },
};

export function isIdeId(value: string): value is IdeId {
  return value === 'vscode' || value === 'cursor';
}

/** Resolve an IDE launcher executable (the shim, e.g. `code.cmd` on Windows). */
export function resolveIdeExecutable(ide: IdeId): string | null {
  const info = IDE_INFO[ide];
  for (const candidate of [info.cmd, ...info.altCmds]) {
    const found = whichSync(candidate);
    if (found) { return found; }
  }
  return null;
}

function whichSync(cmd: string): string | null {
  const isWin = process.platform === 'win32';
  // Prefer .CMD/.BAT over .EXE on Windows: VS Code and Cursor ship a GUI
  // launcher (Code.exe / Cursor.exe) that doesn't accept the --new-window
  // CLI flag, plus a `bin/code.cmd` shim that does. We want the shim.
  const exts = isWin
    ? ['.CMD', '.BAT', '.EXE', '.COM']
    : [''];
  const sep  = isWin ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(sep).filter(Boolean);
  for (const ext of exts) {
    for (const dir of dirs) {
      const full = path.join(dir, cmd + ext);
      try { if (fs.existsSync(full)) { return full; } } catch { /* ignore */ }
    }
  }
  return null;
}

/** Open the workspace folder in the chosen IDE. Detached so the CLI can exit. */
export function launchIde(ide: IdeId, cwd: string, opts: { newWindow?: boolean } = {}): boolean {
  const info = IDE_INFO[ide];
  const exe  = resolveIdeExecutable(ide);
  if (!exe) {
    log.error(`Could not find "${info.cmd}" on PATH. Install ${info.label} and ensure the shell command is registered.`);
    return false;
  }
  // VS Code / Cursor focus the existing window if the folder is already open.
  // --new-window forces a fresh window so the user always sees the launch.
  const args = opts.newWindow !== false ? ['--new-window', cwd] : [cwd];
  try {
    const isWin = process.platform === 'win32';
    const winCmd = isWin ? buildWinCmd(exe, args) : '';
    if (process.env.AUTODEV_DEBUG) {
      log.gray(`exe: ${exe}`);
      log.gray(`cmd: ${winCmd || (exe + ' ' + args.join(' '))}`);
    }
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', winCmd], {
          cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
        })
      : spawn(exe, args, { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    log.success(`Launched ${info.label} → ${cwd}`);
    return true;
  } catch (err) {
    log.error(`Failed to launch ${info.label}: ${(err as Error).message}`);
    return false;
  }
}

// `cmd /s /c "<command>"` strips the outer quote pair before parsing, so we
// wrap our already-quoted command in an EXTRA pair: `cmd /s /c ""path with
// spaces" arg1"`. After stripping, cmd sees `"path with spaces" arg1` which
// parses correctly. Without the extra wrap, cmd splits `D:\Program Files\…`
// at the space and tries to run `D:\Program`.
function buildWinCmd(exe: string, args: string[]): string {
  const inner = [`"${exe}"`, ...args.map(a => `"${a}"`)].join(' ');
  return `"${inner}"`;
}

function spawnIdeCliPiped(exe: string, args: string[]): { status: number | null; stdout: string } {
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', buildWinCmd(exe, args)], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    });
    return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  }
  const r = spawnSync(exe, args, { encoding: 'utf8' });
  return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

function spawnIdeCliInherit(exe: string, args: string[]): { status: number | null } {
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', buildWinCmd(exe, args)], {
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    });
    return { status: r.status };
  }
  const r = spawnSync(exe, args, { stdio: 'inherit' });
  return { status: r.status };
}

/** Returns true if the autoaidev extension is already installed in the IDE. */
export function isAutodevExtensionInstalled(ide: IdeId): boolean {
  const exe = resolveIdeExecutable(ide);
  if (!exe) { return false; }
  const info = IDE_INFO[ide];
  try {
    const r = spawnIdeCliPiped(exe, ['--list-extensions']);
    if (r.status !== 0) { return false; }
    const ids = r.stdout.split(/\r?\n/).map(s => s.trim().toLowerCase());
    return ids.includes(info.extensionId.toLowerCase());
  } catch { return false; }
}

/** Install the autoaidev extension into the IDE. Accepts a marketplace id or a .vsix path. */
export function installAutodevExtension(ide: IdeId, source?: string): boolean {
  const exe = resolveIdeExecutable(ide);
  if (!exe) { return false; }
  const info  = IDE_INFO[ide];
  const target = source ?? info.extensionId;
  log.info(`Installing ${info.extensionId} into ${info.label}…`);
  try {
    const r = spawnIdeCliInherit(exe, ['--install-extension', target, '--force']);
    if (r.status === 0) {
      log.success(`Installed ${info.extensionId} into ${info.label}`);
      return true;
    }
    log.warn(`${info.label} returned exit ${r.status} while installing the extension.`);
    return false;
  } catch (err) {
    log.error(`Extension install failed: ${(err as Error).message}`);
    return false;
  }
}

/** Look for a sibling autoaidev VSIX next to the CLI install (for local/dev installs). */
export function findBundledVsix(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', 'autoaidev.vsix'),
    path.resolve(__dirname, '..', '..', 'autodev-vscode-extension', 'autoaidev.vsix'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { return c; } } catch { /* ignore */ }
  }
  return null;
}
