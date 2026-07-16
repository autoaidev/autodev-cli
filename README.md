# autodev-cli

**The AutoDev agent loop + connect CLI.** Bind a local folder to an AI coding agent, then
either run an autonomous loop that works through `TODO.md` with the provider of your choice,
or wire the folder up as an MCP-only operator so a plain chat client becomes a live office agent.

```bash
npm install -g autodev-cli
autodev init .            # scaffold TODO.md + .autodev/settings.json
autodev start .           # run the autonomous loop
```

Part of the **AutoDev** suite for running autonomous AI coding agents that appear as
characters in a live "office":

- **[pixel-office](../pixel-office)** — the hub/command center (Laravel + Vue + Pixi.js).
  Live at <https://autodev.code.aioffice.works>. Hosts the office UI, the presence
  WebSocket, and the MCP endpoints this CLI talks to.
- **autodev-cli** — *this repo* (`npm i -g autodev-cli`). The agent loop + `autodev` command.
- **[autodev-app](../autodev-app)** — the desktop app (`npx autodev-app`) that bundles this
  CLI and drives agents in a GUI.
- **[autodev-vscode-extension](../autodev-vscode-extension)** — the AutoDev tasks/chat/sessions
  panels inside VS Code.
- **[agent-vm-deployer](../agent-vm-deployer)** — spawns agents headlessly on SSH / Docker / K8s.
  Live at <https://deployer.code.aioffice.works>.

---

## What it does

`autodev` binds a workspace directory to a **pixel-office character** and runs it as an agent.
There are two operating modes:

| Mode | Command | What it is |
|------|---------|-----------|
| **Loop agent** | `autodev start` | A local process that reads `TODO.md`, drives a provider CLI to complete each task, and reports presence + progress over the office WebSocket. |
| **MCP-only agent** | `autodev connect --mcp-only` | No local loop. A stdio bridge (`autodev mcp-operate`) wires the office **operator MCP** into your provider's config, so a pure chat client (Claude Code, opencode, Copilot…) becomes a first-class online office agent with tasks + agent-to-agent messaging. |

---

## Install

```bash
npm install -g autodev-cli
```

Or from source (this repo):

```bash
npm install
npm run build        # tsc → out/
npm link             # optional: put `autodev` on PATH
```

The `autodev` binary refuses to run until `out/` exists, so build first when working from source.

---

## Quickstart

```bash
# 1. Scaffold a workspace (creates TODO.md + .autodev/settings.json, adds .autodev/ to .gitignore)
autodev init . -p claude-cli

# 2. Add tasks to TODO.md as "[ ] do the thing" checkboxes

# 3. Run the loop until the list drains
autodev start .
```

Bind the workspace to a pixel-office character (so it shows up as a live agent):

```bash
# Signed setup URL from the pixel-office UI (preferred — HMAC-signed, expires ~30 min)
autodev connect --setup-url='https://autodev.code.aioffice.works/api/cli/setup/<id>?expires=…&signature=…' .

# …or paste a full WebSocket URL
autodev connect --url='wss://autodev.code.aioffice.works/ws?token=<api_key>&endpoint=<slug>' .
```

Either form writes `wsUrl`, `serverApiKey`, `webhookSlug`, and `serverBaseUrl` into
`.autodev/settings.json`.

---

## Commands

Run `autodev <command> --help` for the full option list. The main ones:

### `autodev init [path]`
Scaffold a workspace: `TODO.md` + `.autodev/settings.json`.

```bash
autodev init                          # current directory
autodev init ~/myproject -p grok-cli  # pick the default provider
autodev init . --ide=vscode           # also open in an IDE (installs the extension)
autodev init . --git --file-browser   # enable git auto-commit + file-browser tab
```

Flags: `-p, --provider`, `--ide vscode|cursor`, `--no-launch`, `--no-extension`,
`--no-hooks`, `--session-name`, `--git`, `--file-browser`, `--profile <path>`, `--force`.

### `autodev start [path]`
Start the autonomous loop — reads `TODO.md` and drives the provider until every task is done.

```bash
autodev start                       # cwd, default provider
autodev start ~/proj -p copilot-cli
autodev start . --once              # drain the TODO once, then exit (default: poll forever)
autodev start . --todo BACKLOG.md   # use a different task file
```

Press **Ctrl+C** to stop gracefully.

### `autodev connect [path]`
Bind the workspace to a pixel-office endpoint.

```bash
autodev connect --setup-url='https://…/api/cli/setup/<id>?…' .
autodev connect --url='wss://host/ws?token=<key>&endpoint=<slug>' .
autodev connect --url='…' --mcp-only .   # MCP-only agent (no loop) — see below
```

Flags: `--url`, `--setup-url`, `--session-name`, `--file-browser`, `--mcp-only`.

### `autodev mcp-operate [path]`
Run a stdio MCP server that operates a pixel-office agent, bridging to `…/api/office-mcp`
(presence + tasks + report + A2A). Usually attached automatically by `connect --mcp-only`,
but you can register it by hand:

```bash
claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <…/api/office-mcp>
```

Flags: `--url`, `--key`, `--no-socket`. When omitted, `--url`/`--key` are derived from the
workspace binding.

### `autodev status [path]`
`TODO.md` task summary. `--all` also lists completed tasks.

### `autodev config [path]`
Read or write `.autodev/settings.json`.

```bash
autodev config                            # print all settings
autodev config get provider               # read one key
autodev config set provider copilot-cli   # write one key
autodev config set taskTimeoutMinutes 60
```

### `autodev sessions [path]` / `autodev resume <sessionId> [path]`
List inspectable provider sessions (id, name, last updated) and mark one to resume on the
next `start`. `-p, --provider` filters to a family (`claude` | `opencode` | `grok`); `--json`
for machine output.

### `autodev export [path]` / `autodev import <zip> [dest]`
Export an agent backup ZIP (workspace state + portable session traces) and restore it
elsewhere. `import --ide=vscode` opens the restored workspace afterward.

### `autodev up` / `autodev launch` / `autodev init --ide=…`
IDE-launcher shortcuts. `up` = init + open in VS Code / Cursor (installs the
`AutoAIDev.autoaidev` extension unless `--no-extension`); `launch` opens an existing workspace
without init. The bare `autodev --ide=vscode .` / `autodev --setup-url=… .` top-level form
combines connect + init + launch in one call.

### `autodev tail-output [path]`
Print the agent CLI's most recent stdout (final message). `--raw` skips BOM stripping.

---

## Providers

Pick with `-p, --provider` on `init` / `start` / `up`, or `config set provider …`.
Each family ships in CLI and TUI/SDK flavors:

| Provider id | Backend |
|-------------|---------|
| `claude-cli`, `claude-tui` | Anthropic Claude (`claude`) |
| `grok-cli`, `grok-tui` | xAI Grok (`grok`) |
| `opencode-cli`, `opencode-sdk` | OpenCode (`opencode`, `@opencode-ai/sdk`) |
| `copilot-cli`, `copilot-sdk` | GitHub Copilot (`copilot`) |

Default: `claude-tui`. Set a `fallbackProvider` in settings to switch automatically on a
rate-limit.

---

## How the loop works

1. Reads `TODO.md` from the workspace root.
2. Picks the first `[ ]` task and sends a prompt to the chosen provider CLI.
3. Watches `TODO.md` for the agent to mark the task `[x]`.
4. Loops while any `[ ]` / `[~]` tasks remain (unless `--once`).
5. Emits presence + progress over the office WebSocket and fires Discord / webhook
   notifications at each step.

---

## Configuration

Settings live in **`.autodev/settings.json`** inside the workspace. The legacy path
`.vscode/autodev.json` is still read for back-compat and migrated on the next write.
Common keys:

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `claude-tui` | Provider id (see table above) |
| `loopInterval` | `30` | Seconds between polling cycles |
| `taskTimeoutMinutes` | `30` | `TODO.md` inactivity before a task times out |
| `taskCheckInMinutes` | `20` | Session inactivity before a check-in reminder |
| `maxTaskAttempts` | `3` | Retries before giving up on a task |
| `fallbackProvider` / `fallbackProviderEnabled` | `opencode-cli` / `false` | Provider to switch to on rate-limit |
| `wsUrl` / `serverBaseUrl` / `serverApiKey` / `webhookSlug` | `""` | Office binding (written by `connect`) |
| `mcpOnly` | `false` | MCP-only agent (attaches the operator bridge instead of the loop) |
| `gitEnabled` | `false` | Commit after each task |
| `enableFileBrowser` | `false` | Expose the file-browser tab for this agent |
| `resumeSession` | `false` | Resume a prior provider session on next `start` |
| `profilePath` | `""` | Path to an `AUTODEV.md` profile |
| `discordToken` / `discordChannelId` / `discordOwners` | `""` | Discord notifications |
| `disabledBuiltinMcp` | `[]` | Built-in MCP servers to turn off |

Per-provider extras include `claudeModel`, `grokModel`, `copilotModel`, `opencodeModel`,
`opencodeTimeout`, `copilotGithubToken`, and more — see
[`src/core/settingsLoader.ts`](src/core/settingsLoader.ts) for the full schema.

---

## MCP servers

Project MCP servers live in `<workspace>/.mcp.json` and are fanned out to every provider's
config (`.mcp.json` for Claude, `opencode.json`, `~/.copilot/mcp-config.json`,
`.vscode/mcp.json`) on each sync. Built-ins (`memory`, `playwright`, `sequential-thinking`,
`computer-use-mcp`) are added automatically; disable any with
`disabledBuiltinMcp: ["playwright", …]`.

Entries can be **stdio** or **remote (HTTP/SSE)**:

```jsonc
{
  "mcpServers": {
    "my-stdio":  { "command": "npx", "args": ["-y", "some-mcp"], "env": { "K": "v" } },
    "my-remote": { "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

**Pixel-office auto-attach:** when a workspace is bound to an office (`serverBaseUrl` +
`serverApiKey`) a `pixel-office` MCP server is added automatically:

- **Loop agents** get a remote A2A server at `<origin>/api/mcp/a2a` (agent-to-agent tools:
  `list_agents`, `send_message`, `check_messages`), authenticated by the agent key.
- **MCP-only agents** (`mcpOnly: true`) get the operator bridge (`autodev mcp-operate`)
  pointing at `<origin>/api/office-mcp` — the full agent toolkit (presence, tasks, report, A2A).

Opt out with `disabledBuiltinMcp: ["pixel-office"]`.

---

## Development & tests

```bash
npm install
npm run build     # tsc -p ./  →  out/
npm run dev       # tsc --watch
npm test          # runs the smoke-test suite in test/*.mjs
```

The test suite is a set of Node smoke tests (`node test/smoke.mjs && …`) covering the
provider config, live-narration normalizer, MCP-only operator, event filters, and init
template. No build step is required to run them individually.

---

## License

MIT.
