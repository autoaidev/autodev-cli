## 0.8 Knowledge Base — `.autodev/knowledgebase/KB-NNN-kebab-title.md`

**Evergreen reference material** — architectural decisions, domain rules, patterns, integration quirks, gotchas. Outlive any individual task. Written when insight is confirmed, never when "there's time later."

**Create when:** Architectural decision made · pattern applies in 2+ places · integration quirk confirmed · recurring question definitively answered · JOURNAL.md `keep` produces transferable insight · TROUBLESHOOTING.md entry generalises to class of problem.

**Naming:** `KB-{NUMBER}-{kebab-case-title}.md` Sequential number (check existing). Use `0` for local. Example: `KB-001-auth-token-refresh-flow.md`

**Sections:** Status · Created/Updated · Summary (≤3 sentences) · Context · Detail · Examples · Caveats · References · Change History (append-only).

**Rules:** Update Detail in place + append Change History when knowledge evolves. Superseded entry → `Status: Deprecated` + `Superseded by:` link. Cross-ref bidirectionally with issues. Never delete. One concept per entry. Self-contained.

**Complete skeleton, all sections, update rules:** skill `kb-reference`
