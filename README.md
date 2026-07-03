# autodev-cli

AutoAIDev's CLI — autonomous AI task loop with an optional one-shot launcher for **VS Code** and **Cursor**, plus a wire-protocol for connecting a workspace to a pixel-office server.

```bash
# Install globally
npm install -g autodev-cli

# Init the current folder + open it in VS Code (or Cursor)
autodev --ide=vscode .
autodev --ide=cursor .

# Connect to a pixel-office agent in one shot (signed URL from the UI)
autodev --setup-url='https://pixel-office.tools.ooyes.net/api/cli/setup/<id>?expires=…&signature=…' .

# Or paste the WS URL directly
autodev --connect='wss://pixel-office.tools.ooyes.net/ws?token=<api_key>&endpoint=<slug>' .

# Combine the two: init + open IDE + bind credentials
autodev --setup-url='…' --ide=vscode .
```

That single command:

1. Creates `TODO.md` and `.autodev/settings.json`
2. Adds `.autodev/` to `.gitignore`
3. Installs the **AutoAIDev** extension into the chosen IDE (skipped if already installed)
4. Opens the folder in the IDE
5. (with `--setup-url` / `--connect`) writes the pixel-office credentials into `.autodev/settings.json`

---

## Install (from this repo)

```bash
cd autodev-cli
npm install
npm run build
npm link            # optional — adds `autodev` to your PATH
```

> Requires the sibling `autodev-vscode-extension` to be compiled first:
> ```bash
> cd ../autodev-vscode-extension
> npm install
> npm run compile
> ```

---

## Commands

### `autodev --ide=<ide> [path]` — top-level shortcut
Same as `autodev up --ide=<ide>`. Inits the workspace and launches the IDE.

### `autodev up --ide=<ide> [path]`
Init + launch in one step. Auto-installs the extension if missing.

```bash
autodev up --ide=vscode .
autodev up --ide=cursor ~/myproject -p copilot-cli
autodev up --ide=vscode . --no-extension      # skip extension install
```

### `autodev launch --ide=<ide> [path]`
Open an existing workspace in an IDE. No init.

### `autodev connect --setup-url=<url> [path]` / `autodev connect --url=<wsurl> [path]`
Bind the workspace to a pixel-office agent.

```bash
# Signed URL from the pixel-office UI (preferred)
autodev connect --setup-url='https://pixel-office.tools.ooyes.net/api/cli/setup/<id>?expires=…&signature=…' .

# Or paste a full WS URL
autodev connect --url='wss://host/ws?token=<api_key>&endpoint=<slug>' .
```

Either form writes `wsUrl`, `serverApiKey`, `webhookSlug`, and `serverBaseUrl` into `.autodev/settings.json`. The signed URL is HMAC-protected and expires in 30 minutes.

### `autodev init [path]`
Scaffold a workspace — `TODO.md` and `.vscode/autodev.json`.
Pass `--ide=vscode|cursor` to also open it after init.

```bash
autodev init                          # current directory
autodev init ~/myproject              # specific path
autodev init . --ide=vscode           # also open in VS Code
autodev init . --ide=cursor --no-extension  # don't auto-install extension
autodev init . --provider claude-cli  # pick the default provider
```

### `autodev start [path]`
Start the autonomous loop — reads `TODO.md` and drives the AI until all tasks are done.

```bash
autodev start                                 # current directory, claude-cli
autodev start ~/myproject -p copilot-cli
autodev start . --provider opencode-cli
```

Press **Ctrl+C** to stop gracefully.

### `autodev status [path]`
Summary of tasks in `TODO.md`.

```bash
autodev status
autodev status ~/myproject --all   # also list completed tasks
```

### `autodev config [path]`
Read or update `.vscode/autodev.json`.

```bash
autodev config                              # print all settings
autodev config get provider                 # get one value
autodev config set provider copilot-cli     # set provider
autodev config set taskTimeoutMinutes 60
autodev config set discordToken TOKEN
```

---

## IDE launcher details

| `--ide` value | Resolves to | Extension installed |
|---------------|-------------|---------------------|
| `vscode`      | `code` (or `code-insiders`) on PATH | `AutoAIDev.autoaidev` |
| `cursor`      | `cursor` on PATH                    | `AutoAIDev.autoaidev` |

The launcher first looks for a sibling `autoaidev.vsix` next to the CLI install (handy for offline / dev installs). If it can't find one it falls back to the marketplace id `AutoAIDev.autoaidev`.

Pass `--no-extension` to skip the extension install. Pass `--no-launch` (only on `init`) to install the extension without opening the IDE.

---

## Configuration

Settings live in `.autodev/settings.json` inside the workspace. The legacy path `.vscode/autodev.json` is still read for back-compat — the next write migrates it to the new location automatically. Highlights:

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `claude-cli` | AI provider to use |
| `loopInterval` | `30` | Seconds between polling cycles |
| `taskTimeoutMinutes` | `30` | Minutes of TODO.md inactivity before timeout |
| `taskCheckInMinutes` | `20` | Minutes of JSONL inactivity before reminder |
| `discordToken` | `""` | Discord bot token for notifications |
| `discordChannelId` | `""` | Discord channel for notifications |
| `serverBaseUrl` | `""` | A2A webhook server URL |
| `serverApiKey` | `""` | A2A webhook API key |
| `gitEnabled` | `false` | Enable git commit after each task |

---

## MCP servers

Project MCP servers live in `<workspace>/.mcp.json` and are fanned out to every provider's config (`.mcp.json` for Claude, `opencode.json`, `~/.copilot/mcp-config.json`, `.vscode/mcp.json`) on each sync.

Built-ins (`memory`, `playwright`, `sequential-thinking`, `computer-use-mcp`) are added automatically. Disable any of them with `disabledBuiltinMcp: ["playwright", …]` in settings.

Entries can be **stdio** or **remote (HTTP/SSE)**:

```jsonc
{
  "mcpServers": {
    "my-stdio":  { "command": "npx", "args": ["-y", "some-mcp"], "env": { "K": "v" } },
    "my-remote": { "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

**Pixel-office A2A:** when an agent is bound to a pixel-office (has `serverBaseUrl` + `serverApiKey`), a remote MCP server named `pixel-office` is auto-attached, pointing at `<origin>/api/mcp` with the agent's api key — giving it agent-to-agent tools (`list_agents`, `send_message`, `check_messages`). Opt out with `disabledBuiltinMcp: ["pixel-office"]`.

---

## How the loop works

1. Reads `TODO.md` from the workspace root
2. Picks the first `[ ]` task, sends a prompt to the chosen AI CLI provider
3. Watches `TODO.md` for the AI to mark the task `[x]` done
4. Loops until all tasks are complete
5. Sends Discord / webhook notifications at each step

The loop never stops while `[ ]` or `[~]` tasks remain.

---

## Providers

| Provider | CLI command |
|----------|-------------|
| `claude-cli` | `claude` (Anthropic Claude CLI) |
| `copilot-cli` | `gh copilot` (GitHub Copilot CLI) |
| `opencode-cli` | `opencode` (OpenCode CLI) |
