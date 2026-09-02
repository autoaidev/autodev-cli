// Offline smoke — installed hook commands must never invoke an Electron (VS Code)
// binary as a plain editor. When hooksManager runs inside the VS Code extension
// host, process.execPath is the `code`/electron binary; baking that into the hook
// command makes every tool event OPEN A VS CODE WINDOW (Electron only acts as
// node when ELECTRON_RUN_AS_NODE=1). This locks the fix in nodeExec()/hookNodeBinary().
// Run: node test/hooksElectronSafe.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hooks-elec-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { installHooks } = await import('../out/hooksManager.js');

function claudeHookCmd(root) {
  const d = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  // Find our appended hook command in any event group.
  for (const groups of Object.values(d.hooks ?? {})) {
    for (const g of groups) {
      const cmd = g?.hooks?.[0]?.command;
      if (typeof cmd === 'string' && cmd.includes('hook-append.mjs')) return cmd;
    }
  }
  throw new Error('no claude hook command found');
}

console.log('hooks electron-safe smoke');

ok('normal (plain-node) install bakes a node runtime, no editor risk', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hooks-node-')));
  installHooks('project', root);
  const cmd = claudeHookCmd(root);
  // execPath here IS node → the command should reference it and never carry a
  // bare Electron invocation.
  assert.ok(cmd.includes('hook-append.mjs'), 'writes the hook script');
  assert.ok(!/code["']?\s+["'][^"']*hook-append\.mjs/.test(cmd) || cmd.includes('ELECTRON_RUN_AS_NODE=1'),
    'never invokes a `code` binary directly on the script');
});

ok('simulated Electron host: hook is forced into node mode / uses a real node', () => {
  const savedExec = process.execPath;
  const savedElectron = process.versions.electron;
  try {
    // Pretend we are the VS Code extension host.
    Object.defineProperty(process, 'execPath', { value: '/usr/share/code/code', configurable: true, writable: true });
    process.versions.electron = '30.0.0-test';

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hooks-elec-')));
    installHooks('project', root);
    const cmd = claudeHookCmd(root);

    // The fake electron binary must NOT be invoked as a plain editor: either the
    // command resolved a real `node` (so it doesn't contain the code path), or it
    // forced ELECTRON_RUN_AS_NODE=1 before the code path.
    const usesFakeCode = cmd.includes('/usr/share/code/code');
    assert.ok(!usesFakeCode || cmd.includes('ELECTRON_RUN_AS_NODE=1'),
      `electron binary must run as node, got: ${cmd}`);
  } finally {
    Object.defineProperty(process, 'execPath', { value: savedExec, configurable: true, writable: true });
    if (savedElectron === undefined) { delete process.versions.electron; }
    else { process.versions.electron = savedElectron; }
  }
});

console.log(`\n${pass} checks passed`);
