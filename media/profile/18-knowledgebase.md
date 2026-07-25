## 0.8 Knowledge Base — `.autodev/knowledgebase/KB-NNN-kebab-title.md`

Evergreen reference (architectural decisions, domain rules, patterns, integration quirks, gotchas) that outlives any task — written the moment an insight is confirmed, not "later".
**Create when:** an architectural decision is made · a pattern applies in 2+ places · an integration quirk is confirmed · a recurring question is definitively answered · a JOURNAL `keep` yields a transferable insight · a TROUBLESHOOTING entry generalises to a class of problem.
**Name:** `KB-{NUMBER}-{kebab-title}.md` (sequential; `0` for local).
**Sections:** Status · Created/Updated · Summary (≤3 sentences) · Context · Detail · Examples · Caveats · References · Change History.

**Rules:** update Detail in place + append Change History as knowledge evolves; superseded → `Status: Deprecated` + `Superseded by:` link; cross-reference bidirectionally with issues; one concept per entry; self-contained; never delete.

Full skeleton + update rules: skill `kb-reference`.
