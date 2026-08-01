# Architecture

A map of the `autodev-cli` source for contributors. Everything below is a real path in
this repo — start here, then read the file. For install/usage see the [README](../README.md).

## Big picture

`autodev` binds a workspace folder to a **pixel-office character** and runs it one of two ways:

- **Loop agent** (`autodev start`) — a long-lived process that reads `TODO.md`, drives a
  provider CLI through each task, and reports presence + activity over the office WebSocket.
- **MCP-only agent** (`autodev connect --mcp-only` → `autodev mcp-operate`) — no loop; a stdio
  (or HTTP) bridge that turns a plain chat client into a live office agent.

Both modes share the same provider abstraction, config, MCP fan-out, and office wiring.

## Entry & command wiring

| Path | Role |
|------|------|
| `bin/autodev.js` | Launch shim. **Hard-exits with code 1 unless `out/cli.js` exists**, so you must `npm run build` when working from source. |
| `src/cli.ts` | Builds the `commander` program: a top-level action (combines connect + init + launch via `--ide` / `--connect` / `--setup-url`) plus the subcommands below. |
| `src/commands/` | One file per command: `init`, `start`, `up` (also registers `launch`), `connect`, `config`, `status`, `sessions` (also `session-show`), `resume`, `export`, `import`, `mcpOperate`, `tailOutput`. |
| `src/cliExit.ts`, `src/version.ts`, `src/logger.ts` | Exit hard-fail guard, version string, logging. |

## The autonomous loop

- `src/taskLoop.ts` (~3.1k lines) — the engine. Reads `TODO.md`, picks the next `[ ]` task,
  prompts the provider, watches for the task to be checked off, retries/timeouts, emits
  presence + progress, fires notifications. Loop agents default `resumeSession=true` (one
  evolving session) unless the setting is explicit.
- `src/todo.ts`, `src/todoWriteManager.ts` — `TODO.md` parse/append. The heading **must** be
  `## Todo`; `appendTask` keys off it.
- `src/messageBuilder.ts`, `src/profileBuilder.ts`, `src/prompt.ts`, `src/protocolSections.ts`
  — assemble the per-turn prompt and the `AUTODEV.md` / SOUL / PROGRAM profile.
- `src/rateLimit.ts`, `src/periodicActions.ts`, `src/sessionState.ts`, `src/journal.ts` —
  rate-limit/fallback handling, periodic check-ins, session bookkeeping.

## Providers

Eight provider ids across four backends (`claude`, `grok`, `opencode`, `copilot`), each in a
CLI and a TUI/SDK flavor.

- `src/providers.ts` — the provider id/label list.
- `src/providers/*` — concrete providers: `claudeCliProvider`, `claudeTuiProvider`,
  `grokTuiProvider`, `opencodeCliProvider`, `opencodeSdkProvider`, `copilotCliProvider`,
  `copilotSdkProvider`, plus `grokSessions` / `copilotSessions` transcript readers.
- `src/core/provider/` — the contract layer: `BaseProvider`, `contract`, `ProviderRegistry`,
  `implementations`.

Provider CLIs are **not** bundled; users install them separately.

## Office / MCP bridge

- `src/commands/mcpOperate.ts` (~1.5k lines) — the operator bridge. Forwards JSON-RPC to
  `…/api/office-mcp`, tails `.autodev/hooks-events.jsonl` + the session transcript to ship
  `hook_event` frames, drives truthful presence, and synthesizes the client-side
  `wait_for_events` / `ask_user` tools. Runs over stdio or (with `--http-port`) persistent
  Streamable HTTP. Single-instance-per-workspace via `.autodev/mcp-operate.lock`.
- `src/mcpManager.ts`, `src/core/projectMcp.ts` — fan `<workspace>/.mcp.json` out to each
  provider's config and auto-attach the built-ins + the `pixel-office` bridge.
- `src/officeSocket.ts`, `src/webSocketPoller.ts`, `src/wsHandshake.ts`, `src/connect.ts`,
  `src/commands/connect.ts` — presence WebSocket, `applyWsUrl` / `applySetupUrl` binding.
- `src/hookEventNormalizer.ts`, `src/hooksManager.ts`, `src/openCodeHooksManager.ts`,
  `src/core/liveNarration.ts` — normalize provider hook events into office activity.

## Config

- `src/core/settingsLoader.ts` — schema + `SETTINGS_DEFAULTS`. Canonical store is
  `<workspace>/.autodev/settings.json` (legacy `.vscode/autodev.json` is read and migrated on
  next write).
- `src/configManager.ts` — read/write, backing `autodev config [get|set]`.
- `src/core/projectSkills.ts` — office-pushed Claude Code skills (`skill_update`).

## Supporting subsystems

| Area | Paths |
|------|-------|
| Interactive panels | `src/git/`, `src/vnc/`, `src/rdp/`, `src/fileBrowser.ts` |
| Backup / move | `src/agentBackup/`, `src/commands/export.ts`, `src/commands/import.ts` |
| Project graph memory | `src/graphStore.ts`, `src/graphRender.ts` |
| Secret redaction | `src/core/redactSecrets.ts` (all outbound content is redacted) |
| Notification / inbound | `src/discordGateway.ts`, `src/discordPoller.ts`, `src/emailPoller.ts`, `src/webhookPoller.ts`, `src/webhook.ts` |
| Usage / limits | `src/sdk/`, `src/core/claudeUsage.ts` |
| Sessions | `src/sessions.ts`, `src/sessionsGlobal.ts` |

## Build & test

```bash
npm install
npm run build     # tsc -p ./  →  out/
npm run dev       # tsc --watch
npm test          # chained Node smoke tests in test/*.smoke.mjs
```

Each smoke test is standalone — `node test/<name>.smoke.mjs` runs without a build (they
import from `out/`, so build first if a test targets compiled code). Note that a few
`test/*.smoke.mjs` files (e.g. `controlSpec`, `journal`, `periodicPreprocess`, `verifyGate`)
exist but are **not** in the `npm test` chain in `package.json`.

## Gotchas

- `bin/autodev.js` refuses to run without `out/` — build from source first.
- `TODO.md` heading must be `## Todo`; the scaffold ships **no** example checkbox because a
  stray `[ ]` line is a real task the agent would execute first.
- Both agent kinds get the **identical** generated `pixel-office` entry; the bridge decides the
  presence socket at **runtime** from `.autodev/ws-presence.lock` (via `foreignLoopOwner`): while a
  live `start` loop owns the slug it stays poll-only (the loop owns the WS + steer delivery),
  otherwise the bridge holds the socket and *is* the MCP-only agent's live connection. `--no-socket`
  is a manual override only — it is no longer hard-coded into the managed config.
- `mcp-operate` is single-instance-per-workspace (newest-wins); a superseded bridge goes
  socket-dormant but keeps serving its stdio client.
- The pixel-office MCP key is read from settings at runtime, never written into a provider
  config; the entry path is relative (`.`) to stay portable.
- Default-provider mismatch: `up` / `launch` default to `claude-cli`; `init` / `start` / root
  default to `claude-tui`.
