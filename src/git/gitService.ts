import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitFile {
  path: string;
  staged: string;   // X from XY porcelain (space = unmodified, M/A/D/R/C/U/?)
  unstaged: string; // Y from XY porcelain
}

export interface GitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  refs: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  const [porcelain, branchRaw] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-u']),
    git(cwd, ['status', '-b', '--porcelain=v1']).catch(() => ''),
  ]);

  let branch = 'HEAD';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  const branchLine = branchRaw.split('\n')[0] ?? '';
  // ## main...origin/main [ahead 2, behind 1]
  const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
  if (branchMatch) {
    branch = branchMatch[1] ?? 'HEAD';
    upstream = branchMatch[2] ?? null;
    const diverge = branchMatch[3] ?? '';
    const aheadMatch = diverge.match(/ahead (\d+)/);
    const behindMatch = diverge.match(/behind (\d+)/);
    if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
    if (behindMatch) behind = parseInt(behindMatch[1], 10);
  }

  const files: GitFile[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 3) continue;
    const X = line[0] ?? ' ';
    const Y = line[1] ?? ' ';
    const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    files.push({ path: filePath, staged: X, unstaged: Y });
  }

  return { branch, upstream, ahead, behind, files };
}

export async function getLog(cwd: string, limit = 50): Promise<GitCommit[]> {
  const SEP = '\x1f';
  const fmt = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ae${SEP}%ci${SEP}%D`;
  const out = await git(cwd, ['log', `--format=${fmt}`, `-${limit}`]);
  return out.split('\n')
    .filter(l => l.trim())
    .map(line => {
      const parts = line.split(SEP);
      return {
        hash:    parts[0] ?? '',
        short:   parts[1] ?? '',
        subject: parts[2] ?? '',
        author:  parts[3] ?? '',
        email:   parts[4] ?? '',
        date:    parts[5] ?? '',
        refs:    parts[6] ?? '',
      };
    });
}

export async function getDiff(cwd: string, filePath: string, staged: boolean): Promise<string> {
  const args = staged
    ? ['diff', '--cached', '--', filePath]
    : ['diff', '--', filePath];
  const out = await git(cwd, args).catch(() => '');
  // If unstaged shows nothing but file is untracked, show full content as addition
  if (!out && !staged) {
    const content = await git(cwd, ['show', `:${filePath}`]).catch(async () => {
      const { readFileSync } = await import('fs');
      const pathMod = await import('path');
      // Containment guard: never read outside the repo even if a caller passes a
      // traversing path. The WS handler already validates, but keep this defensive
      // so getDiff cannot be turned into an arbitrary-file read by another caller.
      const abs = pathMod.resolve(cwd, filePath);
      if (abs !== cwd && !abs.startsWith(cwd + pathMod.sep)) { return ''; }
      try { return readFileSync(abs, 'utf8'); } catch { return ''; }
    });
    if (content) {
      return content.split('\n').map(l => `+${l}`).join('\n');
    }
  }
  return out;
}

export async function getCommitDiff(cwd: string, hash: string, filePath?: string): Promise<string> {
  const args = ['show', '--stat', hash];
  if (filePath) args.push('--', filePath);
  return git(cwd, args).catch(() => '');
}

export async function stageFile(cwd: string, filePath: string): Promise<void> {
  await git(cwd, ['add', '--', filePath]);
}

export async function unstageFile(cwd: string, filePath: string): Promise<void> {
  await git(cwd, ['restore', '--staged', '--', filePath]).catch(() =>
    git(cwd, ['reset', 'HEAD', '--', filePath])
  );
}

export async function stageAll(cwd: string): Promise<void> {
  await git(cwd, ['add', '-A']);
}

export async function commit(cwd: string, message: string): Promise<string> {
  const out = await git(cwd, ['commit', '-m', message]);
  const hashMatch = out.match(/\[.+ ([a-f0-9]+)\]/);
  return hashMatch?.[1] ?? '';
}

export async function fetchOrigin(cwd: string): Promise<void> {
  await git(cwd, ['fetch', '--prune']);
}

export async function getBranches(cwd: string): Promise<{ name: string; current: boolean; remote: boolean }[]> {
  const out = await git(cwd, ['branch', '-a', '--format=%(HEAD) %(refname:short)']).catch(() => '');
  return out.split('\n')
    .filter(l => l.trim())
    .map(line => ({
      current: line.startsWith('*'),
      remote: line.includes('remotes/'),
      name: line.replace(/^\*?\s+/, '').replace(/^remotes\//, ''),
    }));
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['checkout', branch]);
}
