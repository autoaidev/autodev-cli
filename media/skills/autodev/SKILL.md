---
name: autodev
description: The AutoDev autonomous-agent operating protocol: the per-task loop, auto-advance so you never stall, the critic-then-QA done-gate, long-horizon planning, swarms and deterministic workflows, memory and living documents, and self-verification before marking anything done. Trigger when a task involves: running the task loop; TODO; mark [x]; commit; auto mode; advance to next task; don't stall; keep going; before marking done; review; critique; adversarial review; qa; test before done; run it end-to-end; verify on the real product; objective check; tests green; exit 0; HTTP 200; plan; break down; milestones; harden the plan; autoplan; orchestrate; delegate; swarm; subagents; fan-out; deterministic workflow; defer; blocked; deferred task; save progress; resume; checkpoint; compaction; memory; remember; recall; living docs; skill; .claude/skills; discovery sweep; startup; find work; contracts; email a teammate; SOUL; identity; project graph; durable facts; subagent context.
metadata:
  source: autodev-cli
  generated: "true"
license: MIT
---
# AutoDev protocol router

This skill routes you to the AutoDev protocol files already in this workspace under `.autodev/profile/`. They are also summarized always-on in `.autodev/PROGRAM.md`; this skill is the keyword-triggered index to the FULL text of each pillar. When a task matches one of the topics below, READ the linked file and follow it.

## Routing index

### Core loop & auto-advance

- **Identity & Autonomous Mode** — keywords: autonomous; never ask; no confirmation; orchestrator; mark [ ] to [~]; first action; dispatch verify commit; never end while tasks remain → read `.autodev/profile/00-identity.md`
- **Auto-Advance (Never Stall in Auto Mode)** — keywords: auto mode; advance to next task; don't stall; keep going; loop cadence; mark task done; finished a task; next [ ]; do not summarize and stop → read `.autodev/profile/00-auto-advance.md`
- **The Clerk — Capture Every User Request** — keywords: clerk; capture the request; queue this; add to TODO; user reported issue; don't forget; track requests; intake; reconcile todo; never skip a request → read `.autodev/profile/00-clerk.md`
- **Core Loop & Task Classification** — keywords: task loop; TODO; next [ ]; mark [x]; commit; plan dispatch verify; re-read TODO; core loop → read `.autodev/profile/07-core-loop.md`
- **Thinking, Decomposition & Validation** — keywords: thinking; decomposition; six questions; scope impact risks; validation panel; before dispatch; done criteria → read `.autodev/profile/08-thinking.md`
- **TODO.md Format & Marking Rules** — keywords: TODO format; [ ] [~] [x]; marking rules; subtask list; verification subtask; date format → read `.autodev/profile/12-todo-format.md`

### Done-gate: self-verify, critic & QA

- **Critic-Swarm Gate (Refute Before [x])** — keywords: before marking done; review; critique; adversarial review; refute; find bugs; independent critic; producer never self-approves → read `.autodev/profile/00-critic-swarm.md`
- **QA-Swarm Gate (Prove It By Running It)** — keywords: qa; test before done; run the change; end-to-end; verify on real product; done gate; qa swarm; prove it by running it → read `.autodev/profile/00-qa-swarm.md`
- **Self-Verifiable Work** — keywords: mark done; objective check; tests green; exit 0; HTTP 200; evidence; build a checker; verify work; not on a vibe → read `.autodev/profile/00b-self-verifiable-work.md`
- **Turn-End Honest Retrospective & Next Steps** — keywords: end of turn; retrospective; candid verdict; verified vs assumed; next steps; honest done; what went wrong; false done → read `.autodev/profile/00d-turn-end-retrospective.md`
- **QA Swarm** — keywords: qa swarm; run it; end-to-end test; real product; independent tester; test plan; pass fail evidence; gate on qa → read `.autodev/profile/00i-qa-swarm.md`

### Planning

- **Long-Horizon Task Planner** — keywords: plan; planning; break down; roadmap; milestones; acceptance criteria; whole arc; define done; long horizon → read `.autodev/profile/00e-long-horizon-planning.md`
- **Deferred-Task Resolution** — keywords: defer; TODO later; follow-up; out of scope; blocked; deferred set; parked backlog; unblock condition → read `.autodev/profile/00j-deferred-task-resolution.md`
- **Autoplan — Harden The Plan** — keywords: autoplan; auto-review; harden the plan; review the plan; multi-lens critique; approval gate; before building → read `.autodev/profile/00m-autoplan.md`

### Swarms & workflows

- **Swarm Orchestration** — keywords: orchestrate; delegate; swarm; subagents; fan-out; parallel workers; fresh context; stay lean; critic swarm → read `.autodev/profile/00f-swarm-orchestration.md`
- **Swarm Living Documents** — keywords: swarm worker docs; living documents; .autodev/swarm; AGENT.md; worker brief; 16 KB cap; split file; SOUL MEMORY LESSONS TODO → read `.autodev/profile/00g-swarm-living-documents.md`
- **Internal Workflows** — keywords: workflow; multi-stage; fan-out; produce validate critique synthesize; deterministic; template; independent cohorts; not ad-hoc spawns → read `.autodev/profile/00k-internal-workflows.md`
- **Core Rules & File Placement** — keywords: core rules; read before editing; run tests yourself; file placement; subagents scope; never assume → read `.autodev/profile/06-core-rules.md`
- **Parallel Specialist Panel (§2)** — keywords: specialist panel; architect coder reviewer tester ops; roles; blocker back to coder; parallel panel → read `.autodev/profile/09-parallel-panel.md`
- **Subagent Context Management** — keywords: subagent context; CONTEXT.md; subagent brief; when to spawn; don't lose the goal; scoped task → read `.autodev/profile/19-subagent-context-management.md`

### Memory, living docs & continuity

- **Compaction Continuity** — keywords: compaction; context window full; PRE_COMPACT.md; resume after compaction; handoff to future self; in-flight state; continuity → read `.autodev/profile/00l-compaction-continuity.md`
- **Context Checkpoints** — keywords: save progress; save context; save my work; resume; restore context; where was I; checkpoint; .autodev/checkpoints → read `.autodev/profile/00n-context-checkpoints.md`
- **Session Start Order (SUMMARY.md)** — keywords: session start; read order; SUMMARY.md; SOUL AGENTS LESSONS CONTRACTS; startup reading; non-obvious facts → read `.autodev/profile/01-learning.md`
- **Memory MCP — State Persistence** — keywords: memory; persist state; .autodev/memories; MEMORY.md; remember; recall; memory note; after every task → read `.autodev/profile/02-memory-mcp.md`
- **Living Project Docs** — keywords: living docs; PROJECT.md; LESSONS.md; TROUBLESHOOTING.md; SETUP.md; CHANGELOG.md; keep docs current; resolved error → read `.autodev/profile/03-living-docs.md`
- **Research Journal & Auto-Learn Loop** — keywords: journal; research log; hypothesis; experiment; .autodev/journals; keep or discard; tricky fix → read `.autodev/profile/16-journal.md`
- **Issue Tracking (.autodev/issues/)** — keywords: issue tracking; .autodev/issues; ISSUE file; work log; bug ticket; artifact before resolved → read `.autodev/profile/17-issue-tracking.md`
- **Knowledge Base (.autodev/knowledgebase/)** — keywords: knowledge base; .autodev/knowledgebase; KB entry; architectural decision; pattern; gotcha; deprecate superseded → read `.autodev/profile/18-knowledgebase.md`
- **Project Graph — Durable Shared Memory** — keywords: project graph; .autodev/graph; durable facts; graph_neighbors; graph_add_node; claim source; artifact version; supersede → read `.autodev/profile/20-project-graph.md`

### Skills

- **Shared Skills** — keywords: skill; .claude/skills; SKILL.md; reusable procedure; scan skills; shared skill; agent skills; update skill in place → read `.autodev/profile/00h-shared-skills.md`
- **Automatic Skill Development (AGENTS.md)** — keywords: AGENTS.md; single source of truth; conventions; patterns; footgun; update AGENTS; copilot mirror → read `.autodev/profile/04-skill-files.md`
- **Skill Creation Protocol** — keywords: create skill; skill creation; 3+ failed attempts; reusable solution; SKILL.md; repeated mistake → read `.autodev/profile/05-skill-creation.md`

### Discovery & verification

- **Proactive Discovery** — keywords: startup; on join; discovery sweep; find context; roster; list_agents; idle; find work; recall memory; orient → read `.autodev/profile/00a-proactive-discovery.md`
- **Codebase Orientation & Verification** — keywords: orient codebase; entry point; test runner; verify before commit; lint build; security scan; browser check → read `.autodev/profile/10-codebase-verification.md`
- **Git, Debugging & Security** — keywords: git commit; conventional commits; one logical change; debugging; trace error; security; debug method → read `.autodev/profile/11-git-debug-security.md`

### Coordination, threads & identity

- **Self-Verifying Message Threads & Todos** — keywords: message hand-off; A2A message; send_message; context-degraded reader; acceptance criterion; vague referents; verifiable report; complete_task → read `.autodev/profile/00c-verifiable-threads.md`
- **Agent Contracts (CONTRACTS.md)** — keywords: contracts; CONTRACTS.md; email; agent-to-agent; contact address; ACK; terminal message; never invent address → read `.autodev/profile/14-contracts.md`
- **Soul Protocol — Agent Identity** — keywords: SOUL.md; identity; my name; addresses; communication history; who am I; identity anchor → read `.autodev/profile/15-soul.md`

### Engineering principles

- **Workflow, Quality & Principles** — keywords: code quality; magic values; explicit types; single responsibility; surgical changes; principles; workflow → read `.autodev/profile/13-workflow-principles.md`

---

If a `.autodev/profile/<file>.md` link is missing (older workspace), the same content is under its section heading in `.autodev/PROGRAM.md`. This skill supplements — never replaces — the always-loaded PROGRAM.md.
