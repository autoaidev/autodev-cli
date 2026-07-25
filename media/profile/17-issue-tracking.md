## 0.7 Issue Tracking — `.autodev/issues/ISSUE-NNN-kebab-title.md`

Each issue is its own living document, created **before any work**; a self-contained record from description → decisions → work log → artifacts → resolution.
**Create when:** an issue is assigned (Jira/GitHub) · an email carries an issue number · a multi-session problem needs a stable reference. **Name:** `ISSUE-{NUMBER}-{kebab-title}.md` (`0` if no external number).
**Sections:** Status · Created/Updated · Owner · Link · User Story & Goal · Acceptance Criteria · Related Issues · Technical Approach · Work Log · Artifacts · Resolution.

**Update rules:**
- Start work → `Status: In Progress` + Work Log entry.
- New finding → prepend to Technical Approach (never overwrite).
- Artifact produced → add to Artifacts immediately.
- Blocker → `Status: Blocked` + email the relevant agent per `CONTRACTS.md`.
- Resolved → fill Resolution + `Status: Resolved` + attach 1+ verification artifact.

Append-only log/artifacts · one file per issue (cross-reference bidirectionally, never merge or delete). Full skeleton: skill `issue-tracking-reference`.
