# autodev-cli

**The AutoDev agent loop + connect CLI.** Bind a local folder to an AI coding agent, then
either run an autonomous loop that works through `TODO.md` with the provider of your choice,
or wire the folder up as an MCP-only operator so a plain chat client becomes a live office agent.

```bash
npm install -g autodev-cli
autodev init .            # scaffold TODO.md + .autodev/settings.json
# add "[ ] do the thing" checkboxes under the "## Todo" heading in TODO.md
autodev start .           # run the autonomous loop
```

> Provider CLIs (`claude`, `grok`, `opencode`, `copilot`) are **not** bundled —
> install the one you plan to use separately.

## Links

- **GitHub:** [autodev-cli](https://github.com/autoaidev/autodev-cli) *(this repo)* · **npm:** <https://www.npmjs.com/package/autodev-cli> — `npm i -g autodev-cli`
- **Sibling repos:** [pixel-office](https://github.com/peter-mw/pixel-office) · [autodev-app](https://github.com/autoaidev/autodev-app) · [agent-vm-deployer](https://github.com/peter-mw/agent-vm-deployer)
- **Related:** [VS Code extension](https://marketplace.visualstudio.com/items?itemName=AutoAIDev.autoaidev) · [desktop app](https://autoaidev.com/releases/AutoAIDev-desktop-latest.AppImage) · [Pixel Office](https://app.pixeloffice.org) · [Agent VM Deployer](https://deployer.pixeloffice.org)
- **Product sites:** [autoaidev.com](https://autoaidev.com) · [pixeloffice.org](https://pixeloffice.org)

Part of the **AutoDev** suite for running autonomous AI coding agents that appear as
characters in a live "office":

- **[pixel-office](https://github.com/peter-mw/pixel-office)** — the hub/command center
  (Laravel + Vue + Pixi.js). Live at <https://app.pixeloffice.org> (landing:
  <https://pixeloffice.org>). Hosts the office UI, the presence WebSocket, and the MCP
  endpoints this CLI talks to.
- **[autodev-cli](https://github.com/autoaidev/autodev-cli)** — *this repo*
  (`npm i -g autodev-cli`). The agent loop + `autodev` command.
- **[autodev-app](https://github.com/autoaidev/autodev-app)** — the desktop app
  (`npx autodev-app`) that bundles this CLI and drives agents in a GUI.
- **autodev-vscode-extension** — the AutoDev tasks/chat/sessions panels inside VS Code
  ([Marketplace](https://marketplace.visualstudio.com/items?itemName=AutoAIDev.autoaidev)).
- **[agent-vm-deployer](https://github.com/peter-mw/agent-vm-deployer)** — spawns agents
  headlessly on SSH / Docker / K8s. Live at <https://deployer.pixeloffice.org>.

---

## What it does

`autodev` binds a workspace directory to a **pixel-office character** and runs it as an agent.
There are two operating modes:

| Mode | Command | What it is |
|------|---------|-----------|
| **Loop agent** | `autodev start` | A local process that reads `TODO.md`, drives a provider CLI to complete each task, and reports presence + progress over the office WebSocket. |
| **MCP-only agent** | `autodev connect --mcp-only` | No `TODO.md` loop. A stdio bridge (`autodev mcp-operate`) wires the office **operator MCP** into your provider's config, so a pure chat client (Claude Code, opencode, Copilot…) becomes a first-class online office agent — live presence, its own tool activity streamed to the office, plus autonomous execution of assigned tasks and agent-to-agent messaging. |

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
autodev connect --setup-url='https://app.pixeloffice.org/api/cli/setup/<id>?expires=…&signature=…' .

# …or paste a full WebSocket URL
autodev connect --url='wss://app.pixeloffice.org/ws?token=<api_key>&endpoint=<slug>' .
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
autodev start . --force             # bypass the duplicate-loop guard for this workspace
```

Flags: `-p, --provider`, `--todo <file>`, `--once`, `--session-name <name>`, `--force`.
Press **Ctrl+C** to stop gracefully.

> Tasks live under the **`## Todo`** heading in `TODO.md` as `- [ ] task` checkboxes,
> one per line, run top to bottom. The scaffolded template ships with no example task
> on purpose — a stray `[ ]` line is a real task the agent would execute first.

### `autodev connect [path]`
Bind the workspace to a pixel-office endpoint.

```bash
autodev connect --setup-url='https://app.pixeloffice.org/api/cli/setup/<id>?…' .
autodev connect --url='wss://host/ws?token=<key>&endpoint=<slug>' .
autodev connect --url='…' --mcp-only .   # MCP-only agent (no loop) — see below
```

Flags: `--url`, `--setup-url`, `--session-name`, `--file-browser`, `--mcp-only`.

### `autodev mcp-operate [path]`
Run a stdio MCP server that operates a pixel-office agent, bridging to `…/api/office-mcp`
(presence + tasks + report + A2A). Usually attached automatically (it is the `pixel-office`
entry the config sync writes into the provider's `.mcp.json` — see below), but you can
register it by hand:

```bash
claude mcp add pixel-office -- autodev mcp-operate --key <api_key> --url <…/api/office-mcp>
```

When `--url`/`--key` are omitted they are derived from the workspace binding, so inside a
bound workspace just `autodev mcp-operate .` works.

Flags:

| Flag | Effect |
|------|--------|
| `--url <url>` | Operator-MCP endpoint (`…/api/office-mcp`). Default: derived from the binding. |
| `--key <apiKey>` | Character `api_key` (Bearer). Default: the workspace `serverApiKey`. |
| `--http-port <port>` | Serve MCP over persistent Streamable HTTP on this port instead of stdio (point an opencode `type: remote` MCP at `http://<host>:<port>/mcp`). |
| `--http-host <host>` | Bind address for `--http-port` (default `127.0.0.1`). |
| `--no-socket` | Don't open the presence WebSocket — HTTP-only, poll-based presence. |
| `--file-browser` | Serve the office file-browser panel (read/write workspace files). |
| `--git` | Serve the office git panel (status/diff/stage/commit/branch). |
| `--vnc` | Serve office VNC remote-desktop sessions (input + framebuffer). |
| `--rdp` | Serve office RDP remote-desktop sessions (input + framebuffer). |
| `--mcp-update` | Honor `mcp_update` frames — sync office-supplied MCP config to disk (relaunch to pick up spawn changes). |
| `--skill-update` | Honor `skill_update` frames — sync office-supplied Claude Code skills to `.claude/skills/<slug>/SKILL.md` (live-reloads, no relaunch). |

Each capability flag also turns on when the bound workspace has the matching setting
(`enableFileBrowser` / `gitEnabled` / `vncEnabled` / `rdpEnabled` / `mcpUpdateEnabled`); an
explicit flag is sticky and can enable a capability the settings file leaves off.

**It is a full office citizen, not a passive proxy.** Beyond forwarding JSON-RPC to the
operator MCP, a socket-enabled bridge:

- **Forwards the client session's own activity** — tails `.autodev/hooks-events.jsonl` for the
  session's native tool calls (Edit/Bash/Read/…) and tails the session transcript for the
  assistant's prose, shipping both to the office as `hook_event` frames so the Events tab and
  chat reflect a VS Code / Claude Code session's real work (MCP tool calls are skipped — the
  office already logs those server-side).
- **Drives truthful presence** — a debounced working/idle status derived from that activity
  stream (flips to `working` on tool activity, back to `idle` after ~2 min quiet).
- **Autonomously executes assigned office tasks and A2A messages** (claude providers): pulls
  pending tasks, spawns a `claude` worker with an empty strict MCP config to do the work, then
  reports `complete_task`; replies to teammate messages via `check_messages` / `send_message`.
- **Routes all office tool calls over the SAME presence socket** as `operator_request` /
  `operator_response` frames instead of a second HTTP connection, falling back to HTTP only
  while the socket isn't ready (or under `--no-socket`).
- **Is single-instance-per-workspace** (`.autodev/mcp-operate.lock`, newest-wins): a superseded
  older bridge goes dormant — drops its socket and stops reconnecting — but stays alive serving
  its stdio client over the HTTP fallback, so exactly one live presence socket exists per slug.

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

### `autodev sessions [path]` / `autodev session-show <id>` / `autodev resume <sessionId> [path]`
`sessions` lists inspectable provider sessions (id, name, last updated); `resume` marks one to
resume on the next `start`. `-p, --provider` filters to a family
(`claude` | `grok` | `opencode` | `copilot`), `--all` spans every workspace on the machine,
and `--json` emits machine output.

`session-show <id> -p <provider>` prints a normalized transcript for one session
(`--json` for structured output, `--limit <n>` to cap messages, `--file`/`--cwd` to hint
transcript resolution for claude/grok).

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

Default: `claude-tui` for `init` / `start` / the root command; the `up` / `launch` IDE
shortcuts default to `claude-cli`. Set a `fallbackProvider` in settings to switch
automatically on a rate-limit.

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
| `gitEnabled` | `false` | Expose the office git panel (and commit after each task) |
| `enableFileBrowser` | `false` | Expose the file-browser tab for this agent |
| `vncEnabled` / `rdpEnabled` | `false` | Serve VNC / RDP remote-desktop sessions for this agent |
| `mcpUpdateEnabled` | `false` | Honor office-pushed `mcp_update` frames (sync MCP config to disk) |
| `resumeSession` | `false`* | Resume a prior provider session on next `start`. *Loop agents default this to `true` (one evolving session) unless you set it explicitly. |
| `profilePath` | `""` | Path to an `AUTODEV.md` profile |
| `discordToken` / `discordChannelId` / `discordOwners` | `""` | Discord notifications |
| `disabledBuiltinMcp` | `[]` | Built-in MCP servers to turn off |

Per-provider extras include `claudeModel`, `grokModel`, `copilotModel`, `opencodeModel`,
`opencodeTimeout`, `copilotGithubToken`, and more — see
[`src/core/settingsLoader.ts`](src/core/settingsLoader.ts) for the full schema.

---

## MCP servers

Project MCP servers live in `<workspace>/.mcp.json` and are fanned out to every provider's
config on each sync: `.mcp.json` for Claude, `opencode.json`, `.vscode/mcp.json`, and a
**per-workspace** `.autodev/copilot-mcp.json` that Copilot loads via `--additional-mcp-config`
(the global `~/.copilot/mcp-config.json` is intentionally *not* written — per-agent boxes would
clobber each other's bearer token; stale entries there are pruned). Built-ins (`memory`,
`playwright`, `sequential-thinking`,
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
`serverApiKey`) a `pixel-office` MCP server is added automatically. Both agent kinds get the
**same** `autodev mcp-operate` stdio bridge to the operator MCP (`<origin>/api/office-mcp` —
the full toolkit: `get_tasks`, `start_task`, `complete_task`, `report`, `set_status`,
`check_messages`, `send_message`, `list_agents`, …). The bridge also synthesizes two
client-side tools on top of that surface — `wait_for_events` (long-poll for office
steers/messages/tasks) and `ask_user` (put a blocking question to the office). The key is read from
`.autodev/settings.json`, never written into a provider config; the path is relative (`.`) so
the entry stays portable. Both agent kinds get the **identical** generated entry
(`autodev mcp-operate .` + capability flags); the presence socket is decided at **runtime**, not
baked into the config:

- With **no live loop** owning the slug (a pure MCP-only agent), the bridge keeps its presence
  socket — it *is* the character's live connection, so office steers/messages arrive via
  `wait_for_events`.
- When a **live `autodev start` loop** owns the slug (fresh `.autodev/ws-presence.lock` with a
  live pid), the bridge stays poll-only — the loop already holds this slug's WS and delivers
  steers itself, and the last-wins slug→connection index means a second socket would steal the
  slug and swallow the steer. HTTP tools still work fully without it. A periodic reconcile
  yields or re-opens the socket as loops appear/die, so it self-heals. (`--no-socket` still
  exists as a manual override, but is no longer hard-coded into the managed config.)

Enabled interactive capabilities are appended as explicit args to the generated entry
(`--file-browser`, `--git`, `--vnc`, `--rdp`, `--mcp-update`, `--skill-update`) so the managed
`.mcp.json` is self-documenting. Opt out entirely with `disabledBuiltinMcp: ["pixel-office"]`.

---

## Development & tests

```bash
npm install
npm run build     # tsc -p ./  →  out/
npm run dev       # tsc --watch
npm test          # runs the smoke-test suite in test/*.mjs
```

The test suite is a chained set of Node smoke tests (`node test/smoke.mjs && …`) covering the
provider config, live-narration normalizer, MCP-only operator, event filters, secret
redaction, init template, and more. Run any one standalone with `node test/<name>.smoke.mjs`.

For a source-tree map (entry points, the loop engine, providers, the office bridge, config,
and subsystems), see **[docs/architecture.md](docs/architecture.md)**.

---

## License

MIT.
