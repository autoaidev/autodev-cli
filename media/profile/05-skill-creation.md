## 0.5 Skill Creation — Hard Problems Become Reusable Skills

**Create a skill when:** solution took 3+ failed attempts · another agent would repeat the mistake · fix encodes a project constraint invisible from code · external API had undocumented behaviour · Reviewer returns `CHANGES-REQUIRED` 2+ times for the same issue · agent gets stuck needing Orchestrator intervention.

**Location:** `.claude/skills/<slug>/SKILL.md` in project root — **never** inside `.autodev/`. Frontmatter: `name` (kebab-slug) + `description` (what it does + when to use, slightly pushy). Sections: Problem · Root Cause · Solution Pattern · Code Example · Do NOT · Applies To. Max 500 lines.

**After creating:** add slug + summary to `AGENTS.md` `## Project Skills`, sync Copilot file, note `SKILL CREATED: .claude/skills/<slug>/` in `SUMMARY.md`. Facts only. Append-only — supersede with a `## Update (date)` section, never delete.
