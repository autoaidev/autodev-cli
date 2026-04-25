# autodev-cli

Autonomous AI task loop — runs **without VS Code**.

## Install

```bash
# From this directory
npm install
npm run build

# Link globally so `autodev` is on your PATH
npm link
```

> **Prerequisites:** The extension must be compiled first:
> ```bash
> cd ../autodev-vscode-extension
> npm run compile
> ```

---

## Commands

### `autodev init [path]`
Scaffold a workspace — creates `TODO.md` and `.vscode/autodev.json`.

```bash
autodev init                          # current directory
autodev init ~/myproject              # specific path
autodev init . --provider claude-cli  # set default provider
```

### `autodev start [path]`
Start the autonomous loop — reads `TODO.md` and drives the AI until all tasks are done.

```bash
autodev start                           # current directory, claude-cli
autodev start ~/myproject -p copilot-cli
autodev start . --provider opencode-cli
```

Press **Ctrl+C** to stop gracefully.

### `autodev status [path]`
Show a summary of tasks in `TODO.md`.

```bash
autodev status
autodev status ~/myproject --all   # also list completed tasks
```

### `autodev config [path]`
Show or update `.vscode/autodev.json`.

```bash
autodev config                              # print all settings
autodev config get provider                 # get one value
autodev config set provider copilot-cli     # set provider
autodev config set taskTimeoutMinutes 60    # set timeout
autodev config set discordToken TOKEN       # configure Discord
```

---

## Configuration

Settings are stored in `.vscode/autodev.json` inside the workspace directory.

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

## How it works

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
