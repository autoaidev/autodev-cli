import { resolveWithinRoot } from '../core/pathSafe';
import * as gitService from './gitService';

// ---------------------------------------------------------------------------
// gitRequest — shared office git-panel request handler.
//
// The office git panel (browser UI) sends { type:'git_request', requestId,
// action, path?, staged?, message?, branch?, hash? } frames over whichever WS
// channel the agent holds open. A LOOP agent receives these on its
// WebSocketPoller; an MCP-only agent receives them on its OfficeSocket presence
// connection. Both dispatch to this single function so behaviour is identical
// regardless of the transport.
//
// Actions: status / log / diff / commit_diff / stage / unstage / commit /
// fetch / branches / checkout. Every path-bearing arg is resolved via
// resolveWithinRoot(), which enforces containment both lexically and after
// resolving symlinks — a git_request must never read/write host files outside
// the workspace.
// ---------------------------------------------------------------------------

export interface HandleGitRequestOptions {
  /** Absolute workspace root, or null/undefined when none is configured. */
  root: string | null | undefined;
  /** Whether the git panel is enabled for this agent. */
  enabled: boolean;
  requestId: string;
  action: string;
  filePath?: string;
  staged?: boolean;
  message?: string;
  branch?: string;
  hash?: string;
  /** Send a frame back to the server (the caller's WS sendFrame). */
  sendFrame: (frame: Record<string, unknown>) => void;
  /** Optional logger (unused today, accepted for parity/future use). */
  log?: (m: string) => void;
}

/**
 * Handle a git-panel request from the server (originated by the browser UI).
 * Replies via `sendFrame({ type:'git_response', requestId, ok, ...extra })`.
 */
export function handleGitRequest(opts: HandleGitRequestOptions): void {
  const { requestId, action, filePath, staged, message, branch, hash, sendFrame } = opts;

  const respond = (ok: boolean, data?: Record<string, unknown>, error?: string) => {
    sendFrame({ type: 'git_response', requestId, ok, ...(data ?? {}), ...(error ? { error } : {}) });
  };

  const root = opts.root;
  if (!root) { respond(false, undefined, 'No workspace root'); return; }
  if (!opts.enabled) { respond(false, undefined, 'Git not enabled'); return; }

  // Containment guard — mirror handleFbRequest. Every path-bearing arg
  // (filePath) must resolve inside the workspace root both lexically AND after
  // resolving symlinks; otherwise a git_request could read arbitrary host
  // files (e.g. path '../../.claude/.credentials.json' via the readFileSync
  // fallback in getDiff, or leak them through `git diff -- <path>`). An empty
  // filePath means "whole repo" and is permitted (allowRoot).
  if (filePath !== undefined && filePath !== '') {
    if (resolveWithinRoot(root, filePath, true) === null) {
      respond(false, undefined, 'Path outside workspace');
      return;
    }
  }

  (async () => {
    try {
      switch (action) {
        case 'status': {
          const status = await gitService.getStatus(root);
          respond(true, { status });
          break;
        }
        case 'log': {
          const commits = await gitService.getLog(root);
          respond(true, { commits });
          break;
        }
        case 'diff': {
          const diff = await gitService.getDiff(root, filePath ?? '', staged ?? false);
          respond(true, { diff });
          break;
        }
        case 'commit_diff': {
          const diff = await gitService.getCommitDiff(root, hash ?? '', filePath);
          respond(true, { diff });
          break;
        }
        case 'stage': {
          if (filePath) await gitService.stageFile(root, filePath);
          else await gitService.stageAll(root);
          respond(true);
          break;
        }
        case 'unstage': {
          if (!filePath) { respond(false, undefined, 'path required'); break; }
          await gitService.unstageFile(root, filePath);
          respond(true);
          break;
        }
        case 'commit': {
          if (!message) { respond(false, undefined, 'message required'); break; }
          const commitHash = await gitService.commit(root, message);
          respond(true, { hash: commitHash });
          break;
        }
        case 'fetch': {
          await gitService.fetchOrigin(root);
          respond(true);
          break;
        }
        case 'branches': {
          const branches = await gitService.getBranches(root);
          respond(true, { branches });
          break;
        }
        case 'checkout': {
          if (!branch) { respond(false, undefined, 'branch required'); break; }
          await gitService.checkoutBranch(root, branch);
          respond(true);
          break;
        }
        default:
          respond(false, undefined, `Unknown git action: ${action}`);
      }
    } catch (err) {
      respond(false, undefined, String(err));
    }
  })();
}
