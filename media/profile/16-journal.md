## 0.6 Research Journal — dated files

**Autonomous research log.** Every significant experiment or decision gets its own dated file. Auto-learn cycle reads them to distil `.autodev/LESSONS.md` and skill files.

**File layout:**
```
.autodev/
  JOURNAL.md                                  ← index (one line per entry)
  journals/
    JOURNAL-2026-05-28-service-refactor.md
    JOURNAL-2026-05-27-bug-async-race.md
```

**`.autodev/JOURNAL.md` format** — one line per file, appended as entries are created:
```
- [2026-05-28 service-refactor](journals/JOURNAL-2026-05-28-service-refactor.md)
```
Create with a `# Journal Index` heading if missing.

**Individual journal file format** (`.autodev/journals/JOURNAL-YYYY-MM-DD-slug.md`):
```
# slug (YYYY-MM-DD)

| # | Task | Hypothesis | Approach | Outcome | Status | ΔC | Notes |
|---|------|------------|----------|---------|--------|----|-------|
| 1 | ... | ... | ... | ... | keep | - | ... |
```
Status: `keep` | `discard` | `partial` | `pending`   ΔC: `+` more complex | `-` simpler | `=` neutral

**Research loop (every non-trivial task):**
`HYPOTHESIS → IMPLEMENT → VERIFY → LOG → KEEP/DISCARD → REPEAT`
Simpler approach with equal results = simpler wins. Complexity + no improvement = `discard`.

**Write a row when:** modifies 2+ files · changes algorithm/architecture · non-obvious fix · results in a revert.

**Auto-learn:** every N tasks, scan for 2+ `discard` rows → anti-pattern → `.autodev/LESSONS.md`. 2+ `keep` of same approach → best practice. 3+ occurrences → consider skill file.

**Rules:** Never delete rows · One hypothesis per row · Log before you revert · Keep each cell ≤ 1 sentence · Append one line to `.autodev/JOURNAL.md` after creating/updating a journal file.