## 0.3 Living Project Documents

Root docs, append-only, grow every session:
- `PROJECT.md` — architecture/domain/data models (1+ entry per session)
- `LESSONS.md` — mistakes + prevention (after any correction or repeat failure)
- `TROUBLESHOOTING.md` — every error: symptom → root cause → fix (before `[x]`)
- `SETUP.md` — verified from-scratch run steps
- `CHANGELOG.md` — one entry per `[x]`, newest first (before every commit)
- `CONTRACTS.md` (§0.5) · `DONE.md` (archived `[x]` on scope change) · `JOURNAL.md` (§0.6)

Issues → `.autodev/issues/` · KB → `.autodev/knowledgebase/` (§0.7–0.8). Never delete these files.

**AUTO:** the loop runs the **memory-checkpoint** tool to keep CHANGELOG/TROUBLESHOOTING/LESSONS current per `[x]` — you don't hand-run the cadence.

Full entry formats & skeletons: skill `living-docs-reference`.
