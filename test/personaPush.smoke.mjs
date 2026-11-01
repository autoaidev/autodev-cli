// Smoke test for the LIVE persona push + the attached-skills SOUL block.
// Run after `npm run build` (imports compiled JS from out/).
//
// Part A — persona push routed through the REAL WebSocketPoller frame handler:
//   a `source:'persona'` steer frame carrying a structured `persona` payload
//   deterministically writes the SOUL.md persona block (no model self-edit), and
//   a subsequent general/empty persona push REMOVES it. Normal steer handling is
//   not regressed (the steer text is still delivered to onSteer).
//
// Part B — applySkillsToSoul (src/connect.ts): attach adds one
//   `file://./.claude/skills/<slug>/SKILL.md` line per skill, detach drops a line,
//   empty set removes the whole block, and re-syncing the same set is idempotent.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'assert';

import { WebSocketPoller } from '../out/webSocketPoller.js';
import { applySkillsToSoul } from '../out/connect.js';

const PERSONA_BEGIN = '<!-- autodev:persona:begin -->';
const PERSONA_END   = '<!-- autodev:persona:end -->';
const SKILLS_BEGIN  = '<!-- autodev:skills:begin -->';
const SKILLS_END    = '<!-- autodev:skills:end -->';

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)); }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function count(s, marker) { return (s.match(new RegExp(esc(marker), 'g')) || []).length; }

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log(`  ok: ${msg}`); passed++; }

// Build a pixel-office persona-push frame exactly as AgentController::assignPersonality
// enqueues it: an A2A task frame, event='steer', source='persona', with the
// structured persona in metadata.persona.
function personaFrame(taskId, text, persona) {
  return {
    task: {
      id: taskId,
      contextId: 'agent-slug',
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
      metadata: { event: 'steer', task: { text }, source: 'persona', persona },
    },
  };
}

// Drive the real private frame handler with a single final text frame (opcode 0x1).
function deliver(poller, frame) {
  poller._onFrame(true, 0x1, Buffer.from(JSON.stringify(frame)));
}

// ── Part A: persona push through the poller ────────────────────────────────
{
  const root = tmpdir('persona-push');
  const poller = new WebSocketPoller('wss://x/ws?token=t&endpoint=e', 'key', 'agent-slug');
  poller._workspaceRoot = root; // the agent workspace root (private field; plain prop in JS)
  const steers = [];
  poller.setOnSteer((text) => { steers.push(text); });

  // 1) a persona push writes the SOUL.md persona block deterministically
  deliver(poller, personaFrame('t1', '⚙ Persona update — you are now «UX Designer» …',
    { id: 'designer', label: 'UX Designer', prompt: 'You obsess over spacing and contrast.' }));
  const soulPath = path.join(root, 'SOUL.md');
  ok(fs.existsSync(soulPath), 'A: persona push created SOUL.md');
  let body = fs.readFileSync(soulPath, 'utf8');
  ok(body.includes(PERSONA_BEGIN) && body.includes(PERSONA_END), 'A: persona markers present');
  ok(body.includes('UX Designer'), 'A: persona label written');
  ok(body.includes('You obsess over spacing and contrast.'), 'A: persona prompt written');
  ok(count(body, PERSONA_BEGIN) === 1, 'A: exactly one persona block');

  // 2) steer text is STILL delivered to onSteer (normal steer not regressed)
  ok(steers.length === 1 && steers[0].includes('Persona update'), 'A: steer text still delivered to onSteer');

  // 3) a general/empty persona push REMOVES the block (switch back to neutral)
  deliver(poller, personaFrame('t2', '⚙ Persona update — neutral …',
    { id: 'general', label: 'General Agent', prompt: '' }));
  body = fs.readFileSync(soulPath, 'utf8');
  ok(count(body, PERSONA_BEGIN) === 0, 'A: general persona push removed the block');
  ok(!body.includes('You obsess over spacing and contrast.'), 'A: old persona prompt gone');
  ok(steers.length === 2, 'A: second steer text also delivered');

  // 4) a malformed persona (missing fields) must NOT throw / break steer handling
  deliver(poller, personaFrame('t3', '⚙ Persona update — malformed', { nope: true }));
  ok(steers.length === 3, 'A: steer still delivered despite malformed persona payload');

  // 5) a plain steer with NO persona payload is untouched (no SOUL write path)
  const root2 = tmpdir('plain-steer');
  const p2 = new WebSocketPoller('wss://x/ws?token=t&endpoint=e', 'key', 'agent-slug');
  p2._workspaceRoot = root2;
  const s2 = [];
  p2.setOnSteer((text) => { s2.push(text); });
  deliver(p2, {
    task: {
      id: 's1', contextId: 'agent-slug',
      status: { state: 'TASK_STATE_SUBMITTED' },
      metadata: { event: 'steer', task: { text: 'just a normal steer' } },
    },
  });
  ok(s2.length === 1 && s2[0] === 'just a normal steer', 'A: plain steer delivered normally');
  ok(!fs.existsSync(path.join(root2, 'SOUL.md')), 'A: plain steer wrote no SOUL.md');
}

// ── Part B: applySkillsToSoul ───────────────────────────────────────────────
function skillLine(slug) { return `file://./.claude/skills/${slug}/SKILL.md`; }

{
  // attach: two skills → block with one reference line each
  const root = tmpdir('skills-soul');
  const changed = applySkillsToSoul(root, ['code-review', 'dataviz']);
  const soulPath = path.join(root, 'SOUL.md');
  ok(changed === true, 'B: returns true on first skills write');
  let body = fs.readFileSync(soulPath, 'utf8');
  ok(body.includes(SKILLS_BEGIN) && body.includes(SKILLS_END), 'B: skills markers present');
  ok(body.includes('## Skills'), 'B: ## Skills heading present');
  ok(body.includes(skillLine('code-review')), 'B: code-review reference line present');
  ok(body.includes(skillLine('dataviz')), 'B: dataviz reference line present');
  ok(count(body, SKILLS_BEGIN) === 1, 'B: exactly one skills block');

  // idempotent: re-sync same set (order-independent) changes nothing
  const first = fs.readFileSync(soulPath, 'utf8');
  const changed2 = applySkillsToSoul(root, ['dataviz', 'code-review']);
  const second = fs.readFileSync(soulPath, 'utf8');
  ok(changed2 === false, 'B: re-sync of same set returns false (no change)');
  ok(first === second, 'B: re-sync of same set leaves file byte-identical');

  // detach one: the removed slug's line is gone, the other stays
  const changed3 = applySkillsToSoul(root, ['code-review']);
  body = fs.readFileSync(soulPath, 'utf8');
  ok(changed3 === true, 'B: detach returns true');
  ok(body.includes(skillLine('code-review')), 'B: kept skill line remains');
  ok(!body.includes(skillLine('dataviz')), 'B: detached skill line removed');
  ok(count(body, SKILLS_BEGIN) === 1, 'B: still exactly one skills block after detach');

  // empty set → whole block removed
  const changed4 = applySkillsToSoul(root, []);
  body = fs.readFileSync(soulPath, 'utf8');
  ok(changed4 === true, 'B: empty set returns true (block removed)');
  ok(count(body, SKILLS_BEGIN) === 0, 'B: no skills block remains for empty set');
  ok(!body.includes('.claude/skills/'), 'B: no skill reference lines remain');

  // empty set again → no-op
  const changed5 = applySkillsToSoul(root, []);
  ok(changed5 === false, 'B: empty set on a block-free SOUL.md is a no-op');
}

{
  // coexistence: persona block + skills block live together, independently
  const root = tmpdir('soul-coexist');
  // seed a persona block via the poller-equivalent helper path
  const poller = new WebSocketPoller('wss://x/ws?token=t&endpoint=e', 'key', 'agent-slug');
  poller._workspaceRoot = root;
  poller.setOnSteer(() => {});
  deliver(poller, personaFrame('c1', '⚙ Persona update', { id: 'seller', label: 'Sales Pro', prompt: 'Close the deal.' }));
  applySkillsToSoul(root, ['code-review']);
  const body = fs.readFileSync(path.join(root, 'SOUL.md'), 'utf8');
  ok(count(body, PERSONA_BEGIN) === 1 && count(body, SKILLS_BEGIN) === 1, 'B: persona + skills blocks coexist (one each)');
  ok(body.includes('Close the deal.') && body.includes(skillLine('code-review')), 'B: both blocks retain their content');
  // removing skills leaves the persona block intact
  applySkillsToSoul(root, []);
  const after = fs.readFileSync(path.join(root, 'SOUL.md'), 'utf8');
  ok(count(after, SKILLS_BEGIN) === 0 && count(after, PERSONA_BEGIN) === 1, 'B: removing skills leaves persona block intact');
}

console.log(`\npersonaPush.smoke: ${passed} assertions passed`);
