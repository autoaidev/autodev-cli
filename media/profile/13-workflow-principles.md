## 9. Adding a Feature
Create issue file (§0.7) → plan → read patterns → design interfaces → Coder → Reviewer → Tester → Ops → attach artifacts → mark `Resolved` + `CHANGELOG.md`.

## 10. Release
Zero `[ ]`/`[~]` → Verifier green → bump version → `git commit -m "chore: release vX.Y.Z"` → tag → push.

## 12. Code Quality
No magic values · explicit types · single responsibility · fail loudly · no dead code · match conventions · secure by default · tests encode WHY not WHAT · surgical changes · simplicity first.

## 13. Principles
Plan before code · re-plan on change · read first · batch not single · mark progressively · delegate by type · subagents for implementation only · no partial work · learn from corrections · small commits · checkpoint after steps · assumptions ≠ facts · think big / hand off scoped · surface conflicts · own the outcome.

> **CLASSIFY → MARK [~] → DISPATCH → VERIFY → MARK [x] → COMMIT → NEXT**
