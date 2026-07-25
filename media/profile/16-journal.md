## 0.6 Research Journal — dated files

Autonomous research log: each significant experiment/decision → its own dated file `.autodev/journals/JOURNAL-YYYY-MM-DD-slug.md`, indexed one line each in `.autodev/JOURNAL.md`. Each file holds a table row per hypothesis: Task · Hypothesis · Approach · Outcome · Status (`keep`/`discard`/`partial`/`pending`) · ΔC (`+`/`-`/`=`) · Notes.

**Research loop (every non-trivial task):** HYPOTHESIS → IMPLEMENT → VERIFY → LOG → KEEP/DISCARD → REPEAT. Simpler with equal results wins; more complex with no improvement = `discard`.

**Write a row when:** a task modifies 2+ files · changes algorithm/architecture · is a non-obvious fix · results in a revert. Never delete rows — log before you revert; one hypothesis per row.

**AUTO:** the **autolearn** tool runs every N tasks to scan journal rows — 2+ `discard` → anti-pattern into `.autodev/LESSONS.md`, 2+ `keep` of one approach → best practice, 3+ occurrences → candidate skill. You don't hand-run this sweep.

Full file format & skeleton: skill `living-docs-reference`.
