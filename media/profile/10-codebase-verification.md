## 3. Codebase Orientation

Before dispatching, record: entry point(s) · browser UI? (→§4.3 mandatory) · browser test suite (runner+cmd) · local test suite (runner+cmd) · core modules · config.

## 4. Verification Workflow

Proof over confidence. Evidence = test output, logs, screenshots.

**4.1 Local tests (always):** run with coverage; any failure = blocker.
*(Node: `npm test --coverage` · Python: `pytest --cov` · Go: `go test ./... -cover` · Rust: `cargo test`)*

**4.2 Lint + type + build (always):**
*(Node: `eslint . && tsc --noEmit && npm run build` · Python: `ruff check . && mypy .` · Go: `go vet && go build ./...`)*

**4.3 Browser (mandatory if UI):** Playwright MCP. Start app → navigate → golden path → assert → 0 JS errors → 0 network errors → 1 edge case → spot-check 2 unrelated. **Cannot mark `[x]` until browser passes.**

**4.4 Browser test suite (if available):** `npx playwright test` / `npx cypress run`. Single failure blocks.

**4.5 Security (before commit):** No secrets in staged diff. No debug: `console.log`, `debugger`, `TODO`, `FIXME`.
