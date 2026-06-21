import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Protocol sections — for each MCP server enabled in settings, look up
// `media/mcp/<server-name>.md` and inject its contents into the agent profile,
// wrapped in BEGIN/END markers. Toggling an MCP off cleanly removes its block
// on the next regeneration.
//
// Additionally, if `media/skills/<server-name>/SKILL.md` exists for an
// enabled MCP, it is deployed to `.claude/skills/<server-name>/SKILL.md` in
// the workspace so Claude Code loads it automatically. Skills for disabled
// MCPs are removed.
//
// To add a new protocol: drop a markdown file in `media/mcp/` named exactly
// after the MCP server (e.g. `media/mcp/zerolib-email.md`). No code changes
// required. Optionally add `media/skills/<name>/SKILL.md` for Claude skills.
// ---------------------------------------------------------------------------

const BEGIN_MARKER = '<!-- AUTODEV:mcp-protocol:';
const END_MARKER   = ':end -->';

interface SettingsLike {
  mcpServers?: Record<string, { enabled?: boolean } | undefined>;
}

function _isEnabled(s: SettingsLike | undefined, name: string): boolean {
  const entry = s?.mcpServers?.[name];
  if (!entry) return false;
  return entry.enabled !== false;
}

function _mcpDir(): string {
  return path.join(__dirname, '..', 'media', 'mcp');
}

function _skillsMediaDir(): string {
  return path.join(__dirname, '..', 'media', 'skills');
}

/** Strip every existing `<!-- AUTODEV:mcp-protocol:*:begin -->...end -->` block. */
function _stripAllProtocolBlocks(body: string): string {
  // Greedy-safe non-greedy match across newlines
  const re = /\n*<!-- AUTODEV:mcp-protocol:[^:]+:begin -->[\s\S]*?<!-- AUTODEV:mcp-protocol:[^:]+:end -->\n*/g;
  return body.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Strip any existing protocol markers from `body`, then append fresh blocks
 * from `media/mcp/<name>.md` for each MCP currently enabled in `settings`.
 */
export function applyProtocolSections(body: string, settings: SettingsLike | undefined): string {
  let out = _stripAllProtocolBlocks(body).trimEnd();

  const dir = _mcpDir();
  if (!fs.existsSync(dir)) return out + '\n';

  const enabledNames = Object.keys(settings?.mcpServers ?? {})
    .filter(name => _isEnabled(settings, name))
    .sort();

  const additions: string[] = [];
  for (const name of enabledNames) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try { content = fs.readFileSync(file, 'utf8').trim(); } catch { continue; }
    if (!content) continue;
    additions.push(
      `${BEGIN_MARKER}${name}:begin -->\n\n${content}\n\n${BEGIN_MARKER}${name}${END_MARKER}`,
    );
  }

  if (additions.length === 0) return out + '\n';
  return out + '\n\n' + additions.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Skill deployment — copy media/skills/<name>/SKILL.md to
// <root>/.claude/skills/<name>/SKILL.md when the MCP is enabled, and remove
// it when the MCP is disabled or no longer present.
// ---------------------------------------------------------------------------

/**
 * Copy ALL skills from media/skills/ to root/.claude/skills/.
 * This ensures all general skills (not just MCP-related ones) are available to Claude.
 * Does nothing if root is falsy.
 */
export function applyAllSkills(root: string): void {
  if (!root) { return; }

  const skillsMedia = _skillsMediaDir();
  if (!fs.existsSync(skillsMedia)) { return; }

  const skillNames = fs.readdirSync(skillsMedia).filter(n => {
    try { return fs.statSync(path.join(skillsMedia, n)).isDirectory(); } catch { return false; }
  });

  for (const name of skillNames) {
    const srcSkill = path.join(skillsMedia, name, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) { continue; }

    const destDir  = path.join(root, '.claude', 'skills', name);
    const destSkill = path.join(destDir, 'SKILL.md');

    // Always deploy the skill file
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    try {
      const src = fs.readFileSync(srcSkill, 'utf8');
      fs.writeFileSync(destSkill, src, 'utf8');
    } catch { /* ignore write errors */ }
  }
}

/**
 * For every MCP that has a corresponding `media/skills/<name>/SKILL.md`:
 *   - If the MCP is enabled, copy the skill file to `<root>/.claude/skills/<name>/SKILL.md`.
 *   - If the MCP is disabled (or absent), delete `<root>/.claude/skills/<name>/SKILL.md`
 *     if it was previously deployed by autodev.
 *
 * Does nothing if `root` is falsy.
 */
export function applyMcpSkills(root: string, settings: SettingsLike | undefined): void {
  if (!root) { return; }

  const skillsMedia = _skillsMediaDir();
  if (!fs.existsSync(skillsMedia)) { return; }

  const mcpNames = fs.readdirSync(skillsMedia).filter(n => {
    try { return fs.statSync(path.join(skillsMedia, n)).isDirectory(); } catch { return false; }
  });

  for (const name of mcpNames) {
    const srcSkill = path.join(skillsMedia, name, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) { continue; }

    const destDir  = path.join(root, '.claude', 'skills', name);
    const destSkill = path.join(destDir, 'SKILL.md');

    if (_isEnabled(settings, name)) {
      // Deploy the skill file
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      try {
        const src = fs.readFileSync(srcSkill, 'utf8');
        fs.writeFileSync(destSkill, src, 'utf8');
      } catch { /* ignore write errors */ }
    } else {
      // Remove the previously deployed skill file
      try {
        if (fs.existsSync(destSkill)) { fs.unlinkSync(destSkill); }
        // Remove the skill directory if it is now empty
        if (fs.existsSync(destDir) && fs.readdirSync(destDir).length === 0) {
          fs.rmdirSync(destDir);
        }
      } catch { /* ignore */ }
    }
  }
}
