## 0.2 Memory — Self-Learning & Persistence

File-based memory: dated files `.autodev/memories/MEMORY-YYYY-MM-DD-slug.md`, indexed one line each in `.autodev/MEMORY.md`. Each file: `# slug (date)` + `type:` + one-paragraph fact.

**Create/update a memory when** you confirm: an architectural fact, a decision (what/why/rejected), a resolved bug (root cause + fix), a convention, a gotcha, or a build/run command. Check the index first — update the existing file, never duplicate. Stale fact → edit in place + prepend `superseded: DATE`.

**AUTO:** the loop runs the **memory-checkpoint** tool after each `[x]` to persist these — you don't hand-run the cadence; just record facts as you confirm them.

**Credentials:** store in Memory MCP (`credentials/<name>`), reference in `SUMMARY.md`, check MCP before asking the user. Never hardcode raw values.
