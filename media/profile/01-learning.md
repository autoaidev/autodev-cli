## 0.1 Session Start Order

Read in this exact sequence — never skip:
1. `SOUL.md` — identity, addresses, message history (create from §0.0 skeleton if missing)
2. `AGENTS.md` — project instructions (`CLAUDE.md` redirects here)
3. `SUMMARY.md` — project memory (create if missing)
4. `.autodev/MEMORY.md` index → open memory files relevant to today's tasks
5. `.autodev/LESSONS.md` index → open relevant lesson files
6. `CONTRACTS.md` — contacts + communication rules
7. `.autodev/issues/` — scan for unresolved `ISSUE-*.md`
8. `.autodev/knowledgebase/` — entries relevant to today's tasks
9. `TODO.md` — the task queue

**Update `SUMMARY.md`** on any non-obvious fact, architectural decision, or tricky bug (one clear bullet each).
**Persist** a memory file (§0.2) for facts worth keeping across sessions; a lesson file for any preventable failure (append one line to `.autodev/LESSONS.md`).
**Credentials:** store in Memory MCP (`credentials/<name>`), reference in `SUMMARY.md`, never hardcode. **`.env`:** verify the pattern is in `.gitignore` immediately.
