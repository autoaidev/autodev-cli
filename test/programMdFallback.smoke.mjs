// Smoke: a missing/unreadable PROGRAM.md must NEVER fail dispatch.
//
// Repro of the reported bug: an office grok-tui loop failed its task with
//   ENOENT: no such file or directory, open '...\.autodev\PROGRAM.md'
// because writeCombinedFile(includeProfile=true) did a hard readFileSync of
// PROGRAM.md. If the profile build had thrown (Windows media-layout / path issue
// in the scratch dir), PROGRAM.md was absent and the read threw → the TASK failed.
//
// Contract now: writeCombinedFile reads the profile DEFENSIVELY — a missing
// PROGRAM.md yields the message-only combined file, never a throw.
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { writeCombinedFile } = await import('../out/core/commandHelpers.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-programmd-'));
try {
  // Arrange: a real message file, but NO PROGRAM.md on disk.
  const msgDir = path.join(root, '.autodev', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  const messageFile = path.join(msgDir, 'msg.md');
  fs.writeFileSync(messageFile, 'TASK: do the thing', 'utf8');
  const missingProfile = path.join(root, '.autodev', 'PROGRAM.md'); // intentionally absent
  assert.ok(!fs.existsSync(missingProfile), 'precondition: PROGRAM.md absent');

  // Act + Assert: includeProfile=true with a missing profile must NOT throw.
  let combinedFile;
  assert.doesNotThrow(() => {
    combinedFile = writeCombinedFile(root, missingProfile, messageFile, true);
  }, 'writeCombinedFile must not throw when PROGRAM.md is missing');

  const combined = fs.readFileSync(combinedFile, 'utf8');
  assert.ok(combined.includes('TASK: do the thing'), 'combined file carries the task message');
  console.log('  ✓ missing PROGRAM.md + includeProfile → no throw, message-only combined file');

  // And when PROGRAM.md exists, it IS appended.
  fs.writeFileSync(missingProfile, '# AutoDev — PROGRAM.md\nprofile body here', 'utf8');
  const combinedFile2 = writeCombinedFile(root, missingProfile, messageFile, true);
  const combined2 = fs.readFileSync(combinedFile2, 'utf8');
  assert.ok(combined2.includes('profile body here'), 'existing PROGRAM.md is appended');
  assert.ok(combined2.includes('TASK: do the thing'), 'task message still present');
  console.log('  ✓ present PROGRAM.md → appended after the task message');

  console.log('\nprogramMdFallback smoke: 2 checks passed');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
