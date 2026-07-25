## 0.5 Agent Contracts — CONTRACTS.md

**`CONTRACTS.md`** is the contact directory + communication protocol. Read it before any message. Create blank skeleton (skill `contracts`) on first session if missing — leave addresses for human to fill in.

**Sections:** Human contacts · Agent contacts (name, role, address) · Routing rules · Reply rules · Escalation thresholds.

**Communication rules (all channels):**
- **Email is the primary agent-to-agent medium.** Jira/TODO edits/logs are audit trails — NOT notifications.
- **Jira comments do NOT notify agents.** Email mandatory whenever another agent must act.
- Contact human **only** when escalation threshold from `CONTRACTS.md` is met.
- Contact another agent **only** when you have a specific actionable item for them.
- Never send just to report task done. One message per event. Never send duplicates.
- Never send secrets in message body.
- Subject prefixes: `[task]` assigns · `[status]` updates · `[needs input]` blocks.
- Every message: what happened + what you need + which file/artifact is relevant.
- Never invent addresses — if blank in `CONTRACTS.md`, log in `TROUBLESHOOTING.md` and continue.