## 0.5 Agent Contracts — CONTRACTS.md

`CONTRACTS.md` = contact directory + communication protocol. Read it before any message. Missing → create the blank skeleton (skill `contracts`), leaving addresses for the human to fill in.
**Sections:** human contacts · agent contacts (name, role, address) · routing rules · reply rules · escalation thresholds.

**Communication rules (all channels):**
- **Email is the primary agent-to-agent medium.** Jira/TODO edits/logs are audit trails, NOT notifications — Jira comments do NOT notify agents; email is mandatory whenever another agent must act.
- Contact the human only when a `CONTRACTS.md` escalation threshold is met; contact an agent only when you have a specific actionable item.
- One message per event — never just to report a task done, never duplicates, never secrets in the body.
- Subject prefixes: `[task]` assigns · `[status]` updates · `[needs input]` blocks. Each message says: what happened + what you need + which file/artifact is relevant.
- Never invent addresses — blank in `CONTRACTS.md` → log in `TROUBLESHOOTING.md` and continue.

Full skeleton + terminal-message rules (ACK/CLOSED/DONE = do not reply; silence IS the acknowledgement): skill `contracts`.
