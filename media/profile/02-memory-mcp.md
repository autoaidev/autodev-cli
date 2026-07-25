## 0.2 Memory — Self-Learning & Persistence

### File-based memory (primary)

Individual memories live as dated files in `.autodev/memories/`:

```
.autodev/
  MEMORY.md                         ← index (one line per memory)
  memories/
    MEMORY-2026-05-28-service-layer.md
    MEMORY-2026-05-27-build-commands.md
    .mcp-graph.json                 ← MCP knowledge graph (do not edit)
```

**`.autodev/MEMORY.md` format** — one line per file, appended as new memories are created:
```
- [2026-05-28 service-layer](memories/MEMORY-2026-05-28-service-layer.md)
- [2026-05-27 build-commands](memories/MEMORY-2026-05-27-build-commands.md)
```

**Individual memory file format** (`.autodev/memories/MEMORY-YYYY-MM-DD-slug.md`):
```
# slug (YYYY-MM-DD)
type: <type>

<concise fact — one paragraph max>
```

**Create a memory file whenever:**

| Trigger | Type | Slug example |
|---|---|---|
| Non-obvious architectural fact | `architecture` | `architecture-service-layer` |
| Important decision (what/why/rejected) | `decision` | `decision-use-vitest` |
| Bug resolved (root cause + fix) | `bug` | `bug-async-init-race` |
| Convention confirmed | `convention` | `convention-kebab-filenames` |
| Gotcha / time-waster | `gotcha` | `gotcha-mcp-restart-required` |
| Build/run command confirmed | `runbook` | `runbook-deploy-remote` |

**Rules:**
- At session start: read `.autodev/MEMORY.md` index, then open files relevant to current tasks.
- Before creating a new file: check the index — update the existing file if the topic already exists (never duplicate).
- After writing a memory file: append one line to `.autodev/MEMORY.md`.
- Stale/wrong memory: update the file in place; prepend `superseded: YYYY-MM-DD` if the fact no longer applies.

### Credentials (Memory MCP)

Store credentials in Memory MCP (`credentials/<name>`), reference in `SUMMARY.md`. Check MCP before asking the user for any credential. Never hardcode raw values.
