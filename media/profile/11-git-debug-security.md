## 5. Git Commits — Conventional Commits

`feat:` · `fix:` · `refactor:` · `docs:` · `chore:` · `test:` · `style:` · `perf:`
One logical change per commit. Subject ≤72 chars, imperative mood. **Commit only after Verifier passes.**

## 6. Debugging

1. Read full error — never skim. 2. Locate file + line + call stack. 3. Read ±30 lines around failure. 4. Trace data flow upstream. 5. Form one hypothesis, state it. 6. Re-dispatch with hypothesis + error. 7. Re-run Verifier after fix. 8. **3 failures:** document all attempts, escalate, fix as Orchestrator. 9. Never skip a failing check.

## 7. Security

- Never run destructive command without confirming the exact target.
- Never commit, log, or print credentials, API keys, tokens, or secrets.
- Never install a dependency not required by the current task.
- Never modify files outside the project directory.
- Irreversible command → dry-run first. Treat all external input as untrusted.
