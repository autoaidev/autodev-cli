// Offline smoke — Claude permission settings must NOT use the invalid `allow: ["*"]`
// wildcard, which newer Claude Code rejects with a "Settings Warning … Invalid
// permission rule '*' was skipped" and drops. The valid way to bypass all prompts
// is defaultMode: 'bypassPermissions'. This also proves the cleanup of a stale "*"
// left in `allow` by older CLI versions (as seen on live agent workspaces).
// Run: node test/claudePermissions.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// Isolate HOME so we don't touch the real ~/.claude.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-claudeperm-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { ConfigManager } = await import('../out/configManager.js');

function project(seed) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cp-')));
  if (seed !== undefined) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(seed));
  }
  ConfigManager.applyClaudePermissions(root);
  return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
}

console.log('claude permissions smoke');

ok('a fresh project uses defaultMode, never allow:*', () => {
  const perms = project(undefined).permissions;
  assert.strictEqual(perms.defaultMode, 'bypassPermissions', 'bypass prompts via defaultMode');
  assert.ok(!Array.isArray(perms.allow) || !perms.allow.includes('*'), 'no invalid "*" in allow');
});

ok('a stale allow:["*"] is stripped and replaced with defaultMode', () => {
  const perms = project({ permissions: { allow: ['*'] } }).permissions;
  assert.strictEqual(perms.defaultMode, 'bypassPermissions');
  assert.ok(!('allow' in perms) || !perms.allow.includes('*'), 'the invalid wildcard is gone');
});

ok('real allow entries survive; only the "*" is removed', () => {
  const perms = project({ permissions: { allow: ['Bash(ls)', '*', 'mcp__pixel-office__*'] } }).permissions;
  assert.deepStrictEqual(perms.allow, ['Bash(ls)', 'mcp__pixel-office__*'], 'kept valid rules, dropped "*"');
  assert.strictEqual(perms.defaultMode, 'bypassPermissions');
});

ok('the user-level settings also get bypass (no wildcard)', () => {
  project(undefined); // writes ~/.claude/settings.json under the isolated HOME
  const user = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(user.permissions.defaultMode, 'bypassPermissions');
  assert.strictEqual(user.permissions.skipDangerousModePermissionPrompt, true);
  assert.ok(!Array.isArray(user.permissions.allow) || !user.permissions.allow.includes('*'));
});

console.log(`\n${pass} checks passed`);
