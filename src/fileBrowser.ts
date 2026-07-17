import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from './core/pathSafe';

// ---------------------------------------------------------------------------
// fileBrowser — shared office file-browser request handler.
//
// The office file browser (browser UI) sends { type:'fb_request', requestId,
// action, path, content?, newPath?, query? } frames over whichever WS channel
// the agent holds open. A LOOP agent receives these on its WebSocketPoller; an
// MCP-only agent receives them on its OfficeSocket presence connection. Both
// dispatch to this single function so behaviour is identical regardless of the
// transport.
//
// Actions: list / read / write / delete / rename / download / mkdir / search.
// Mutating actions (write/delete/rename/mkdir) are never permitted at the
// workspace root. Every path is resolved via resolveWithinRoot(), which
// enforces containment both lexically and after resolving symlinks.
// ---------------------------------------------------------------------------

export interface HandleFbRequestOptions {
  /** Absolute workspace root, or null/undefined when none is configured. */
  root: string | null | undefined;
  /** Whether the file browser is enabled for this agent. */
  enabled: boolean;
  requestId: string;
  action: string;
  relPath: string;
  content?: string;
  newPath?: string;
  query?: string;
  /** Send a frame back to the server (the caller's WS sendFrame). */
  sendFrame: (frame: Record<string, unknown>) => void;
  /** Optional logger (unused today, accepted for parity/future use). */
  log?: (m: string) => void;
}

/**
 * Handle a file-browser request from the server (originated by the browser UI).
 * Replies via `sendFrame({ type:'fb_response', requestId, ok, ...extra })`.
 */
export function handleFbRequest(opts: HandleFbRequestOptions): void {
  const { requestId, action, relPath, content, newPath, query, sendFrame } = opts;

  const respond = (ok: boolean, extra?: Record<string, unknown>) => {
    sendFrame({ type: 'fb_response', requestId, ok, ...extra });
  };

  if (!opts.enabled) {
    respond(false, { error: 'File browser not enabled' });
    return;
  }

  const root = opts.root;
  if (!root) {
    respond(false, { error: 'No workspace root configured' });
    return;
  }

  // Resolve and validate path is within workspace root. The root itself is
  // permitted for read-only actions (list/search) but never for mutations.
  // Containment is lexical AND canonical (realpath) — a workspace symlink
  // pointing outside must not let a remote fb_request read/write host files.
  const resolveSafe = (rel: string, allowRoot: boolean): string | null =>
    resolveWithinRoot(root, rel, allowRoot);

  const MUTATING = new Set(['write', 'delete', 'rename', 'mkdir']);
  const allowRoot = !MUTATING.has(action);
  const absPath = resolveSafe(relPath, allowRoot);
  if (!absPath) {
    respond(false, {
      error: allowRoot ? 'Path outside workspace' : 'Refusing to modify workspace root',
    });
    return;
  }

  try {
    switch (action) {
      case 'list': {
        const entries = fs.readdirSync(absPath, { withFileTypes: true }).map(e => {
          const stat = (() => { try { return fs.statSync(path.join(absPath, e.name)); } catch { return null; } })();
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: stat?.size ?? 0,
            mtime: stat?.mtimeMs ?? 0,
          };
        });
        // Dirs first, then files; both alphabetical
        entries.sort((a, b) => {
          if (a.type !== b.type) { return a.type === 'dir' ? -1 : 1; }
          return a.name.localeCompare(b.name);
        });
        respond(true, { entries });
        break;
      }

      case 'read': {
        const stat = fs.statSync(absPath);
        const MAX_BYTES = 1_048_576; // 1 MB
        if (stat.size > MAX_BYTES) {
          respond(false, { error: `File too large (${stat.size} bytes, limit 1 MB)` });
          break;
        }
        // Binary detection: read first 512 bytes and check for null bytes
        const sample = Buffer.allocUnsafe(Math.min(512, stat.size));
        const fd = fs.openSync(absPath, 'r');
        fs.readSync(fd, sample, 0, sample.length, 0);
        fs.closeSync(fd);
        const isBinary = sample.includes(0x00);
        if (isBinary) {
          respond(false, { error: 'Binary file — cannot display' });
          break;
        }
        const fileContent = fs.readFileSync(absPath, 'utf8');
        respond(true, { content: fileContent });
        break;
      }

      case 'write': {
        if (content === undefined) {
          respond(false, { error: 'No content provided' });
          break;
        }
        fs.writeFileSync(absPath, content, 'utf8');
        respond(true);
        break;
      }

      case 'delete': {
        fs.rmSync(absPath, { recursive: true, force: true });
        respond(true);
        break;
      }

      case 'rename': {
        if (!newPath) {
          respond(false, { error: 'No newPath provided' });
          break;
        }
        const absNewPath = resolveSafe(newPath, false);
        if (!absNewPath) {
          respond(false, { error: 'newPath outside workspace' });
          break;
        }
        fs.renameSync(absPath, absNewPath);
        respond(true);
        break;
      }

      case 'download': {
        const stat = fs.statSync(absPath);
        const MAX_DOWNLOAD_BYTES = 25 * 1_048_576; // 25 MB — base64 ~1.33x in heap
        if (stat.size > MAX_DOWNLOAD_BYTES) {
          respond(false, { error: `File too large (${stat.size} bytes, limit 25 MB)` });
          break;
        }
        const buf = fs.readFileSync(absPath);
        respond(true, { base64: buf.toString('base64') });
        break;
      }

      case 'mkdir': {
        fs.mkdirSync(absPath, { recursive: true });
        respond(true);
        break;
      }

      case 'search': {
        const rawQuery = (query ?? '').toLowerCase().trim();
        if (!rawQuery) { respond(true, { results: [] }); break; }
        const results: { path: string; name: string; type: string }[] = [];
        const walk = (dir: string, relDir: string, depth: number) => {
          if (depth > 8 || results.length >= 300) return;
          let dirents: fs.Dirent[];
          try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of dirents) {
            if (results.length >= 300) break;
            const rel = relDir ? `${relDir}/${e.name}` : e.name;
            if (e.name.toLowerCase().includes(rawQuery)) {
              results.push({ path: rel, name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
            }
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor') {
              walk(path.join(dir, e.name), rel, depth + 1);
            }
          }
        };
        walk(absPath, '', 0);
        respond(true, { results });
        break;
      }

      default:
        respond(false, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    respond(false, { error: String(err) });
  }
}
