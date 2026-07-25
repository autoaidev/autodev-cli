## 0.7 Issue Tracking — `.autodev/issues/ISSUE-NNN-kebab-title.md`

**Each issue gets its own living document.** Create before any work. It is the single record from description through decisions, work log, artifacts, and resolution — readable alone, no external lookups needed.

**Create when:** Jira/GitHub issue assigned · email with issue number · multi-session problem needs stable reference.

**Naming:** `ISSUE-{NUMBER}-{kebab-case-title}.md` (use `0` if no external number). Example: `ISSUE-123-user-login-timeout.md`.

**Sections:** Status · Created/Updated · Owner · Link · User Story & Goal · Acceptance Criteria · Related Issues · Technical Approach (prepend, never overwrite) · Work Log (append-only) · Artifacts · Resolution.
*(Full skeleton: skill `issue-tracking-reference`)*

**Update rules:**
- Starting work → `Status: In Progress` + Work Log entry.
- New finding → prepend to Technical Approach; never overwrite.
- Artifact produced → add to Artifacts immediately (screenshots, logs, diffs, test output).
- Blocker → `Status: Blocked` + email relevant agent per `CONTRACTS.md`.
- Resolved → fill Resolution + `Status: Resolved` + attach verification artifacts.

**Rules:** Create before working · Append-only log and artifacts · One file per issue (cross-reference, never merge) · Self-contained · Every resolved issue needs 1+ artifact · Cross-references bidirectional · Never delete.