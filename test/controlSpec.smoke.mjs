// Offline smoke — .autodev/CONTROL.md control-spec loader.
//
// The #1 safety requirement of the verify_and_keep feature: with NO CONTROL.md,
// loadControlSpec() returns null and isGateActive() is false, so every new loop
// path is skipped and the loop behaves byte-for-byte as today. This locks that,
// plus present/partial parsing.
// Run: node test/controlSpec.smoke.mjs   (after npm run build)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadControlSpec, isGateActive, parseControlYaml, isMechanicalFailure, matchesAnyGlob } =
  await import('../out/core/controlSpec.js');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✓', name); pass++; };

function ws() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-ctrl-')));
  fs.mkdirSync(path.join(d, '.autodev'), { recursive: true });
  return d;
}
const writeCtrl = (d, body) => fs.writeFileSync(path.join(d, '.autodev', 'CONTROL.md'), body);

console.log('controlSpec smoke');

// ── 1. ABSENT file ⇒ null ⇒ gate inactive (the whole no-breakage guarantee). ──
ok('absent CONTROL.md returns null and the gate is inactive', () => {
  const d = ws();
  const spec = loadControlSpec(d);
  assert.strictEqual(spec, null, 'no CONTROL.md must return null');
  assert.strictEqual(isGateActive(spec), false, 'a null spec must not activate the gate');
  assert.strictEqual(isGateActive(undefined), false);
});

// ── 2. Present, full spec parses from a fenced ```yaml block. ──
ok('a full fenced yaml CONTROL.md parses every field', () => {
  const d = ws();
  writeCtrl(d, [
    '# Control', '',
    '```yaml',
    'verify:',
    '  - npm run build',
    '  - npm test',
    'protected_files:',
    '  - package.json',
    '  - "src/core/**"',
    'max_fix_rounds: 5',
    'max_mechanical_fixes: 2',
    'budget_seconds: 600',
    'keep_on: green',
    'escalate_when:',
    '  - two consecutive discards',
    'exhaustion: open a blocker task and continue',
    '```',
  ].join('\n'));
  const spec = loadControlSpec(d);
  assert.ok(spec, 'spec must load');
  assert.strictEqual(isGateActive(spec), true, 'a verify command activates the gate');
  assert.deepStrictEqual(spec.verify, ['npm run build', 'npm test']);
  assert.deepStrictEqual(spec.protected_files, ['package.json', 'src/core/**']);
  assert.strictEqual(spec.max_fix_rounds, 5);
  assert.strictEqual(spec.max_mechanical_fixes, 2);
  assert.strictEqual(spec.budget_seconds, 600);
  assert.strictEqual(spec.keep_on, 'green');
  assert.deepStrictEqual(spec.escalate_when, ['two consecutive discards']);
  assert.match(spec.exhaustion, /blocker/);
});

// ── 3. Partial spec ⇒ documented defaults, still valid. ──
ok('a partial spec fills defaults (fix_rounds=3, mech=1, budget=null)', () => {
  const d = ws();
  writeCtrl(d, '```yaml\nverify: pytest -q\n```');
  const spec = loadControlSpec(d);
  assert.deepStrictEqual(spec.verify, ['pytest -q'], 'scalar verify becomes a one-element array');
  assert.strictEqual(spec.max_fix_rounds, 3);
  assert.strictEqual(spec.max_mechanical_fixes, 1);
  assert.strictEqual(spec.budget_seconds, null, 'no budget ⇒ null (no budget kill)');
  assert.deepStrictEqual(spec.protected_files, []);
  assert.strictEqual(spec.keep_on, 'green');
  assert.strictEqual(isGateActive(spec), true);
});

// ── 4. Present-but-no-verify ⇒ present spec, gate still inactive. ──
ok('a CONTROL.md with no verify command does NOT activate the gate', () => {
  const d = ws();
  writeCtrl(d, '```yaml\nprotected_files:\n  - .env\n```');
  const spec = loadControlSpec(d);
  assert.ok(spec, 'spec still loads (protected_files set)');
  assert.strictEqual(isGateActive(spec), false, 'no verify ⇒ gate off ⇒ today behavior');
});

// ── 5. control.yml alternative + inline array form. ──
ok('.autodev/control.yml and inline [ ] arrays parse', () => {
  const d = ws();
  fs.writeFileSync(path.join(d, '.autodev', 'control.yml'), 'verify: ["make check"]\nprotected_files: [a.txt, b.txt]\n');
  const spec = loadControlSpec(d);
  assert.deepStrictEqual(spec.verify, ['make check']);
  assert.deepStrictEqual(spec.protected_files, ['a.txt', 'b.txt']);
});

// ── 6. Malformed YAML never throws — returns a safe (inactive) spec. ──
ok('garbage content does not throw', () => {
  const d = ws();
  writeCtrl(d, '```yaml\n:::: not yaml :::\n\t- broken\n```');
  const spec = loadControlSpec(d); // must not throw
  assert.ok(spec === null || typeof spec === 'object');
});

// ── 7. Mechanical-failure classifier. ──
ok('isMechanicalFailure flags type/import/syntax, not logic failures', () => {
  assert.strictEqual(isMechanicalFailure("error TS2304: Cannot find name 'foo'"), true);
  assert.strictEqual(isMechanicalFailure('ModuleNotFoundError: No module named x'), true);
  assert.strictEqual(isMechanicalFailure('SyntaxError: unexpected token'), true);
  assert.strictEqual(isMechanicalFailure('AssertionError: expected 2 to equal 3'), false);
});

// ── 8. Protected-file glob matcher. ──
ok('matchesAnyGlob honors **, *, and bare basenames', () => {
  assert.strictEqual(matchesAnyGlob('src/core/settingsLoader.ts', ['src/core/**']), true);
  assert.strictEqual(matchesAnyGlob('package.json', ['package.json']), true);
  assert.strictEqual(matchesAnyGlob('deep/nested/package.json', ['package.json']), true, 'bare name matches basename anywhere');
  assert.strictEqual(matchesAnyGlob('src/app.ts', ['src/core/**']), false);
  assert.strictEqual(matchesAnyGlob('a.env', ['*.env']), true);
});

// ── 9. Raw parser sanity. ──
ok('parseControlYaml handles list + scalar mix', () => {
  const r = parseControlYaml('a: 1\nb:\n  - x\n  - y\nc: hello\n');
  assert.strictEqual(r.a, '1');
  assert.deepStrictEqual(r.b, ['x', 'y']);
  assert.strictEqual(r.c, 'hello');
});

console.log(`\n${pass} checks passed`);
