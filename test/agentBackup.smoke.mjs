// Guards the agent backup CONTRACT: the project graph and the newer .autodev
// state (program.md, CONTROL.md, journals, memories) must round-trip through
// export→import, the graph must REPLAY after restore, the destination agent's
// identity must be preserved, and the disposable graph snapshot must be excluded.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { createAgentBackup, restoreAgentBackup } = require('../out/agentBackup/index.js');
const { GraphStore } = require('../out/graphStore.js');
const { rebuildProfile } = require('../out/messageBuilder.js');
const AdmZip = require('adm-zip');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-src-'));
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-dest-'));
const zip = path.join(os.tmpdir(), `bk-${process.pid}.zip`);
const ad = path.join(SRC, '.autodev');
fs.mkdirSync(ad, { recursive: true });

// project graph (+ snapshot cache) and the new-stuff files
const g = new GraphStore(SRC, { agentId: 'src', runId: 'run-1' });
const e = g.addNode({ type: 'entity', name: 'UsageService', summary: 'metering' });
const c = g.addNode({ type: 'claim', name: 'retries 3x', source: 'src/usage.ts:42' });
g.addEdge({ type: 'mentions', from: c.node.id, to: e.node.id });
if (g.materializeSnapshot) { g.materializeSnapshot(); }
fs.writeFileSync(path.join(ad, 'CONTROL.md'), '```yaml\nverify: ["true"]\n```\n');
fs.mkdirSync(path.join(ad, 'journals'), { recursive: true });
fs.writeFileSync(path.join(ad, 'journals', 'JOURNAL-2026-07-25-x.md'), '| t | h |\n');
fs.mkdirSync(path.join(ad, 'memories'), { recursive: true });
fs.writeFileSync(path.join(ad, 'memories', 'MEMORY-x.md'), '# x\n');
fs.writeFileSync(path.join(ad, 'settings.json'), JSON.stringify({ wsUrl: 'wss://SRC?token=SECRET', serverApiKey: 'SRCKEY', provider: 'grok-cli' }));
fs.writeFileSync(path.join(SRC, 'SOUL.md'), '# Soul\nName: Epic Grok\n');
fs.writeFileSync(path.join(SRC, 'TODO.md'), '- [ ] t\n');
rebuildProfile(SRC);

(async () => {
  await createAgentBackup(SRC, zip);
  const entries = new AdmZip(zip).getEntries().map(x => x.entryName);
  const has = p => entries.some(x => x.endsWith(p));
  ok(has('.autodev/graph/graph.jsonl'), 'graph.jsonl captured');
  ok(!has('.autodev/graph/graph.snapshot.json'), 'disposable snapshot EXCLUDED');
  ok(has('.autodev/PROGRAM.md'), 'PROGRAM.md captured');
  ok(has('.autodev/CONTROL.md'), 'CONTROL.md captured');
  ok(has('.autodev/journals/JOURNAL-2026-07-25-x.md'), 'journals captured');
  ok(has('.autodev/memories/MEMORY-x.md'), 'memories captured');
  ok(has('workspace/SOUL.md'), 'SOUL.md captured');
  const z = new AdmZip(zip);
  const st = JSON.parse(z.readAsText(z.getEntries().find(x => x.entryName.endsWith('.autodev/settings.json')).entryName));
  ok(st.wsUrl === undefined && st.serverApiKey === undefined, 'settings identity stripped');
  ok(st.provider === 'grok-cli', 'settings non-identity kept');

  // import into a dest that has its OWN identity
  fs.mkdirSync(path.join(DEST, '.autodev'), { recursive: true });
  fs.writeFileSync(path.join(DEST, '.autodev', 'settings.json'), JSON.stringify({ wsUrl: 'wss://DEST/own', serverApiKey: 'DESTKEY' }));
  await restoreAgentBackup(zip, DEST);

  ok(fs.existsSync(path.join(DEST, '.autodev', 'graph', 'graph.jsonl')), 'graph.jsonl restored');
  const g2 = new GraphStore(DEST, { agentId: 'dest', runId: 'r' });
  ok(g2.query({ type: 'entity' }).some(n => n.name === 'UsageService'), 'graph REPLAYS after restore');
  ok(g2.query({ type: 'claim' }).some(n => n.source === 'src/usage.ts:42'), 'sourced claim survives replay');
  ok(fs.existsSync(path.join(DEST, '.autodev', 'CONTROL.md')), 'CONTROL.md restored');
  ok(fs.existsSync(path.join(DEST, '.autodev', 'journals', 'JOURNAL-2026-07-25-x.md')), 'journals restored');
  ok(fs.existsSync(path.join(DEST, 'SOUL.md')), 'SOUL.md restored');
  const ds = JSON.parse(fs.readFileSync(path.join(DEST, '.autodev', 'settings.json'), 'utf8'));
  ok(ds.wsUrl === 'wss://DEST/own', 'dest identity preserved (not hijacked)');
  ok(ds.provider === 'grok-cli', 'non-identity restored from backup');

  fs.rmSync(SRC, { recursive: true, force: true });
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  console.log(`\nagentBackup smoke: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
