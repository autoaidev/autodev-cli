// Smoke test for persona → SOUL.md wiring (src/connect.ts applyPersonaToSoul).
// Run after `npm run build` (imports the compiled JS from out/).
//
// Covers:
//   (a) applying a persona to a fresh dir creates SOUL.md with the marked block
//       containing the label + prompt;
//   (b) re-applying the same persona is idempotent (one block, unchanged);
//   (c) applying a DIFFERENT persona replaces the block (old prompt gone, new
//       present, non-persona content preserved);
//   (d) a general/empty-prompt persona injects no block (and clears a prior one).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'assert';

import { applyPersonaToSoul } from '../out/connect.js';

const BEGIN = '<!-- autodev:persona:begin -->';
const END   = '<!-- autodev:persona:end -->';

function countBlocks(s) {
  const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return (s.match(re) || []).length;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persona-smoke-'));
}

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
}

// (a) fresh dir → creates SOUL.md with the marked block + label + prompt
{
  const root = tmpdir();
  const persona = { id: 'designer', label: 'UX Designer', prompt: 'You obsess over spacing and contrast.' };
  const changed = applyPersonaToSoul(root, persona);
  const soul = path.join(root, 'SOUL.md');
  ok(changed === true, '(a) returns true on fresh write');
  ok(fs.existsSync(soul), '(a) SOUL.md created');
  const body = fs.readFileSync(soul, 'utf8');
  ok(body.includes(BEGIN) && body.includes(END), '(a) markers present');
  ok(body.includes('## Persona'), '(a) has ## Persona heading');
  ok(body.includes('UX Designer'), '(a) contains label');
  ok(body.includes('You obsess over spacing and contrast.'), '(a) contains prompt');
  ok(/## My Identity/.test(body), '(a) minimal identity header present');
  ok(countBlocks(body) === 1, '(a) exactly one block');
}

// (b) re-applying the same persona is idempotent
{
  const root = tmpdir();
  const persona = { id: 'designer', label: 'UX Designer', prompt: 'You obsess over spacing.' };
  applyPersonaToSoul(root, persona);
  const soul = path.join(root, 'SOUL.md');
  const first = fs.readFileSync(soul, 'utf8');
  const changed2 = applyPersonaToSoul(root, persona);
  const second = fs.readFileSync(soul, 'utf8');
  ok(countBlocks(second) === 1, '(b) still exactly one block');
  ok(first === second, '(b) content unchanged on re-apply');
  ok(changed2 === false, '(b) returns false (no change)');
}

// (c) different persona replaces the block; non-persona content preserved
{
  const root = tmpdir();
  applyPersonaToSoul(root, { id: 'designer', label: 'UX Designer', prompt: 'Old spacing prompt.' });
  const soul = path.join(root, 'SOUL.md');
  // Simulate agent-written content outside the block.
  let body = fs.readFileSync(soul, 'utf8');
  body += '\n## Communication History\n\n- 2026-07-25 hello from Bob\n';
  fs.writeFileSync(soul, body, 'utf8');

  const changed3 = applyPersonaToSoul(root, { id: 'seller', label: 'Sales Pro', prompt: 'New selling prompt.' });
  const after = fs.readFileSync(soul, 'utf8');
  ok(changed3 === true, '(c) returns true on replace');
  ok(countBlocks(after) === 1, '(c) still exactly one block');
  ok(!after.includes('Old spacing prompt.'), '(c) old prompt gone');
  ok(after.includes('New selling prompt.'), '(c) new prompt present');
  ok(after.includes('Sales Pro'), '(c) new label present');
  ok(after.includes('hello from Bob'), '(c) non-persona content preserved');
  ok(after.includes('## Communication History'), '(c) agent section preserved');
}

// (d) general / empty-prompt persona injects no block (and clears prior one)
{
  // d1: general on a fresh dir → no SOUL.md, no-op
  const root1 = tmpdir();
  const changedGeneral = applyPersonaToSoul(root1, { id: 'general', label: 'General', prompt: '' });
  ok(changedGeneral === false, '(d) general on fresh dir is a no-op');
  ok(!fs.existsSync(path.join(root1, 'SOUL.md')), '(d) no SOUL.md created for general');

  // d2: empty prompt (non-general id) → no block
  const root2 = tmpdir();
  const changedEmpty = applyPersonaToSoul(root2, { id: 'x', label: 'X', prompt: '   ' });
  ok(changedEmpty === false, '(d) empty/whitespace prompt is a no-op');

  // d3: general clears a previously-applied block, preserving other content
  const root3 = tmpdir();
  applyPersonaToSoul(root3, { id: 'designer', label: 'UX Designer', prompt: 'Design prompt.' });
  const soul3 = path.join(root3, 'SOUL.md');
  let b = fs.readFileSync(soul3, 'utf8');
  b += '\n## Communication History\n\n- kept row\n';
  fs.writeFileSync(soul3, b, 'utf8');
  const cleared = applyPersonaToSoul(root3, { id: 'general', label: 'General', prompt: '' });
  const afterClear = fs.readFileSync(soul3, 'utf8');
  ok(cleared === true, '(d) general removes a prior block');
  ok(countBlocks(afterClear) === 0, '(d) no persona block remains');
  ok(!afterClear.includes('Design prompt.'), '(d) prior prompt gone');
  ok(afterClear.includes('kept row'), '(d) other content preserved after clear');
}

// (e) User custom data preservation — rich hand-written SOUL.md must survive
// persona apply / swap / remove UNTOUCHED; only the delimited block is written.
{
  const rootU = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-user-'));
  const soulU = path.join(rootU, 'SOUL.md');
  const USER = '# SOUL.md\n\n## My Identity\nName: Nova\nEmail: nova@team.dev\n\n## Communication History\n- hand-written note the user must keep\n\n## Custom Section\nsecret personal data\n';
  fs.writeFileSync(soulU, USER);
  const intactU = () => {
    const s = fs.readFileSync(soulU, 'utf8');
    return s.includes('Name: Nova') && s.includes('nova@team.dev')
      && s.includes('hand-written note the user must keep') && s.includes('secret personal data');
  };
  applyPersonaToSoul(rootU, { id: 'designer', label: 'Designer', prompt: 'design-obsessed' });
  ok(intactU(), '(e) user data intact after persona apply');
  ok(countBlocks(fs.readFileSync(soulU, 'utf8')) === 1, '(e) exactly one block after apply');
  applyPersonaToSoul(rootU, { id: 'architect', label: 'Architect', prompt: 'systems architect' });
  ok(intactU() && countBlocks(fs.readFileSync(soulU, 'utf8')) === 1, '(e) user data intact + one block after swap');
  applyPersonaToSoul(rootU, { id: 'general', label: 'General', prompt: '' });
  ok(intactU() && !fs.readFileSync(soulU, 'utf8').includes('autodev:persona:begin'), '(e) user data intact after general removes block');
  fs.rmSync(rootU, { recursive: true, force: true });
}

console.log(`\npersona.smoke: ${passed} assertions passed`);
