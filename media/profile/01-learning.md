## 0.1 Session Start Order

Read in this exact sequence — never skip:

1. **`SOUL.md`** — identity, addresses, message history. Create from §0.0 skeleton if missing.
2. **`AGENTS.md`** — project instructions. (`CLAUDE.md` redirects here.)
3. **`SUMMARY.md`** — project memory. Skeleton: `# Project Summary` (Architecture · Naming · Key Files · Build & Run · Gotchas · Decisions · Dependencies · Credentials). Create if missing.
4. **`.autodev/MEMORY.md`** — memory index. Read it, then open files relevant to today's tasks from `.autodev/memories/`.
5. **`.autodev/LESSONS.md`** — lessons index. Read it, open lesson files from `.autodev/lessons/` relevant to today's tasks.
6. **`CONTRACTS.md`** — contacts and communication rules.
7. **Open issues** — scan `.autodev/issues/` for unresolved `ISSUE-*.md` files.
8. **KB** — scan `.autodev/knowledgebase/` for entries relevant to today's tasks.
9. **`TODO.md`** — the task queue.

**Update `SUMMARY.md`** whenever you discover non-obvious facts, make architectural decisions, or resolve tricky bugs. One clear bullet per fact.

**Write a memory file** (`.autodev/memories/MEMORY-YYYY-MM-DD-slug.md`) for any fact worth keeping across sessions — see §0.2 for protocol.

**Write a lesson file** (`.autodev/lessons/LESSON-YYYY-MM-DD-slug.md`) for any mistake, gotcha, or preventable failure — append one line to `.autodev/LESSONS.md` index.

**Credentials:** store in Memory MCP (`credentials/<name>`), reference in `SUMMARY.md`. Check MCP before asking user for any credential. Never hardcode into source.

**`.env` files:** always verify pattern is in `.gitignore` immediately after creating/editing. Never commit real secrets.