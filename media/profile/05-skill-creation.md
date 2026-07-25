## 0.5 Skill Creation — Hard Problems Become Reusable Skills

**Create a skill when:** solution required 3+ failed attempts · another agent would make the same mistake · fix encodes a project-specific constraint not visible from code · external API had undocumented behaviour.

**Location:** `.claude/skills/<slug>/SKILL.md` in project root. **Never** inside `.autodev/`.

**Required SKILL.md frontmatter:**
```yaml
---
name: <kebab-slug>
description: >-  What this skill does and when to use it (be slightly pushy to avoid undertriggering).
---
```
**Sections:** Problem · Root Cause · Solution Pattern · Code Example · Do NOT · Applies To. Max 500 lines.

**Triggers:** Reviewer returns `CHANGES-REQUIRED` 2+ times for same issue · bug existed across multiple sessions · agent gets stuck requiring Orchestrator intervention.

**After creating:** Add to `AGENTS.md` `## Project Skills` + sync Copilot file. Add `SKILL CREATED: .claude/skills/<slug>/` to `SUMMARY.md`. Facts only — no speculation. Append-only (supersede with `## Update (date)` section, never delete).