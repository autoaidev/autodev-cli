import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { log } from '../logger';

// ---------------------------------------------------------------------------
// `autodev deprovision [path]` — remove the pixel-office MCP server (and its
// stale permission grants) from EVERY layer autodev / a client may have written
// it to, so it stops respawning and stops being inherited by unrelated folders.
//
// Why this exists: a pixel-office server definition written into a GLOBAL config
// (Claude's user-scope `~/.claude.json` mcpServers, or `~/.claude/settings.json`)
// is inherited by every working directory and is relaunched by the client even
// after you kill the running `autodev mcp-operate` process — so it looks
// un-removable from the per-project side. Current `autodev` provisioning only
// writes FOLDER-scoped configs, but older provisioning (or a manually pasted
// `claude mcp add pixel-office … -s user`) can leave a global entry behind. This
// command cleans all of them.
//
// It is conservative: it only ever REMOVES entries whose name is `pixel-office`
// or `pixel-office-<agent>` (and the matching `mcp__pixel-office*` permission
// allowlist entries). Every other key in every file is preserved verbatim.
// ---------------------------------------------------------------------------

/** True for the office server name and any per-agent `pixel-office-<slug>` variant. */
function isOfficeServerName(name: string): boolean {
  return name === 'pixel-office' || name.startsWith('pixel-office-');
}

/** True for a permission allow-rule that grants a pixel-office MCP server. */
function isOfficePermission(rule: string): boolean {
  // e.g. mcp__pixel-office, mcp__pixel-office__send_message, mcp__pixel-office-a1
  return /^mcp__pixel-office(-[^_]+)?(__.*)?$/.test(rule);
}

interface Change { file: string; detail: string; }

function readJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) { return null; }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch { return null; }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : null;
}

/** Delete office-named keys from a `<container>[key]` map. Returns removed names. */
function stripServerMap(container: Record<string, unknown> | null, key: string): string[] {
  const map = container ? asObj(container[key]) : null;
  if (!map) { return []; }
  const removed: string[] = [];
  for (const name of Object.keys(map)) {
    if (isOfficeServerName(name)) { delete map[name]; removed.push(name); }
  }
  return removed;
}

/** Remove office permission rules from a `permissions.allow` array. Returns removed rules. */
function stripPermissionAllow(cfg: Record<string, unknown> | null): string[] {
  const perms = cfg ? asObj(cfg['permissions']) : null;
  if (!perms || !Array.isArray(perms['allow'])) { return []; }
  const before = perms['allow'] as unknown[];
  const removed = before.filter(r => typeof r === 'string' && isOfficePermission(r)).map(String);
  if (removed.length) { perms['allow'] = before.filter(r => !(typeof r === 'string' && isOfficePermission(r))); }
  return removed;
}

/** Remove office names from a string[] (e.g. enabledMcpjsonServers). Returns removed. */
function stripStringList(container: Record<string, unknown> | null, key: string): string[] {
  if (!container || !Array.isArray(container[key])) { return []; }
  const before = container[key] as unknown[];
  const removed = before.filter(n => typeof n === 'string' && isOfficeServerName(n)).map(String);
  if (removed.length) { container[key] = before.filter(n => !(typeof n === 'string' && isOfficeServerName(n))); }
  return removed;
}

/** Strip office `[mcp_servers.<name>]` (+ nested) tables from a grok TOML file. */
function stripGrokToml(text: string): { out: string; removed: string[] } {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  const removed = new Set<string>();
  let skipping = false;
  for (const line of lines) {
    const m = /^\s*\[\s*mcp_servers\.([^\].]+)(?:\.[^\]]+)?\s*\]/.exec(line);
    if (m) {
      // A new mcp_servers table header — decide whether to drop this block.
      const name = m[1].replace(/^["']|["']$/g, '');
      skipping = isOfficeServerName(name);
      if (skipping) { removed.add(name); continue; }
    } else if (/^\s*\[/.test(line)) {
      // Any other table header ends a skipped block.
      skipping = false;
    }
    if (!skipping) { kept.push(line); }
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { out: out ? out + '\n' : '', removed: [...removed] };
}

export function deprovisionCommand(program: Command): void {
  program
    .command('deprovision [path]')
    .description('Remove the pixel-office MCP server + stale mcp__pixel-office permissions from every config layer (global + this workspace) so it stops respawning / being inherited everywhere')
    .option('--dry-run', 'Report what would change without writing any file')
    .option('--no-workspace', 'Only clean the GLOBAL layers; leave this workspace\'s folder-scoped configs untouched')
    .action((workspacePath: string | undefined, opts: { dryRun?: boolean; workspace: boolean }) => {
      const root = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const dry = !!opts.dryRun;
      const changes: Change[] = [];

      // Apply `mutate` to a JSON file, writing it back only if `mutate` reported
      // removals. Preserves every non-office key and the file's other contents.
      const editJson = (file: string, mutate: (cfg: Record<string, unknown>) => string[]): void => {
        const cfg = readJsonOrNull(file);
        if (!cfg) { return; }
        const removed = mutate(cfg);
        if (!removed.length) { return; }
        for (const r of removed) { changes.push({ file, detail: r }); }
        if (!dry) {
          try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); }
          catch (e) { log.warn(`  could not write ${file}: ${(e as Error).message}`); }
        }
      };

      const home = os.homedir();

      // ── GLOBAL layers (the inheritance / respawn source) ────────────────────
      // ~/.claude.json — user-scope mcpServers + every project's mcpServers /
      // enabledMcpjsonServers. This is the entry inherited by EVERY folder.
      editJson(path.join(home, '.claude.json'), (cfg) => {
        const removed = stripServerMap(cfg, 'mcpServers');
        const projects = asObj(cfg['projects']);
        if (projects) {
          for (const proj of Object.values(projects)) {
            const p = asObj(proj);
            if (!p) { continue; }
            removed.push(...stripServerMap(p, 'mcpServers'));
            removed.push(...stripStringList(p, 'enabledMcpjsonServers'));
          }
        }
        return removed;
      });

      // ~/.claude/settings.json — user-scope mcpServers + permission allowlist.
      editJson(path.join(home, '.claude', 'settings.json'), (cfg) => {
        return [...stripServerMap(cfg, 'mcpServers'), ...stripPermissionAllow(cfg)];
      });

      // ~/.copilot/mcp-config.json — global copilot MCP config.
      editJson(path.join(home, '.copilot', 'mcp-config.json'), (cfg) => stripServerMap(cfg, 'mcpServers'));

      // ── Workspace (folder-scoped) layers ────────────────────────────────────
      if (opts.workspace !== false) {
        editJson(path.join(root, '.mcp.json'), (cfg) =>
          [...stripServerMap(cfg, 'mcpServers'), ...stripServerMap(cfg, 'servers')]);
        editJson(path.join(root, '.vscode', 'mcp.json'), (cfg) => stripServerMap(cfg, 'servers'));
        editJson(path.join(root, 'opencode.json'), (cfg) => stripServerMap(cfg, 'mcp'));
        editJson(path.join(root, '.autodev', 'copilot-mcp.json'), (cfg) => stripServerMap(cfg, 'mcpServers'));
        editJson(path.join(root, '.claude', 'settings.json'), (cfg) =>
          [...stripServerMap(cfg, 'mcpServers'), ...stripPermissionAllow(cfg)]);
        editJson(path.join(root, '.claude', 'settings.local.json'), (cfg) =>
          [...stripServerMap(cfg, 'mcpServers'), ...stripPermissionAllow(cfg)]);

        // Grok TOML is not JSON — strip the office [mcp_servers.*] tables textually.
        const grok = path.join(root, '.grok', 'config.toml');
        if (fs.existsSync(grok)) {
          try {
            const before = fs.readFileSync(grok, 'utf8');
            const { out, removed } = stripGrokToml(before);
            if (removed.length) {
              for (const r of removed) { changes.push({ file: grok, detail: `[mcp_servers.${r}]` }); }
              if (!dry) { fs.writeFileSync(grok, out, 'utf8'); }
            }
          } catch (e) { log.warn(`  could not process ${grok}: ${(e as Error).message}`); }
        }
      }

      // ── Report ──────────────────────────────────────────────────────────────
      log.section('🧹 AutoAIDev — deprovision pixel-office');
      if (!changes.length) {
        log.success('No pixel-office entries or permissions found. Nothing to remove.');
        return;
      }
      log.info(`${dry ? 'Would remove' : 'Removed'} ${changes.length} entr${changes.length === 1 ? 'y' : 'ies'}:`);
      for (const c of changes) {
        log.gray(`  ${c.detail}  ←  ${c.file.replace(home, '~')}`);
      }
      if (dry) { log.warn('Dry run — no files were modified. Re-run without --dry-run to apply.'); }
      else { log.success('Done. Restart any open client (grok / VS Code / Claude) so it drops the removed server.'); }
    });
}
