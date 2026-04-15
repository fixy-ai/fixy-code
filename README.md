# Fixy Code

**One terminal. Multiple AI coding agents. Working together.**

Fixy Code lets you talk to Claude, Codex, and Gemini in a single conversation — at the same time. Each agent reviews the others, challenges bad ideas, and helps you pick the best solution. You keep your existing subscriptions. Fixy Code just coordinates.

> For the full product experience and web app, visit [fixy.ai](https://fixy.ai)
> For Fixy Code documentation and updates, visit [fixy.ai/code](https://fixy.ai/code)

---

## What problem does it solve?

Every AI coding tool gives you one agent's opinion. That agent will confidently agree with your bad ideas, miss its own blind spots, and never tell you when it's wrong.

Fixy Code fixes this by putting Claude (Anthropic), Codex (OpenAI), and Gemini (Google) in the same room. They were trained by different companies with different blind spots. Their disagreements are signal, not noise.

---

## How it works

You type a task. Fixy routes it to the agents you choose. They discuss, plan, and execute — in your terminal, on your machine, using your existing auth.

```
❯ @claude review this function and suggest improvements
❯ @codex do you agree with Claude's suggestion?
❯ @fixy /all  ← make all agents collaborate on one task
❯ /compact    ← summarize a long conversation to save context
```

Fixy Code never stores your code, your prompts, or your credentials. Everything runs locally.

### Real-time thinking & activity

See what agents are doing as they work — not just the final answer:

```
@claude:
  · Analyzing the authentication flow for security issues...
  · Reading src/auth.ts
  · Reading src/middleware.ts
  
  I found 3 issues in your auth implementation...
```

Thinking and tool activity (file reads, edits, shell commands) appear as dim activity lines in real-time. Toggle with `Ctrl+T`.

### Smart question detection

`/all` automatically detects whether your input is a question or a task:

- **Questions** (`@fixy /all should we use Redis?`) — agents discuss in parallel, skip the execution pipeline
- **Tasks** (`@fixy /all build a REST API`) — full plan/execute/review pipeline
- **Force execute** (`@fixy /all! improve error handling`) — always runs full pipeline

---

## No login required

If you're already logged into Claude Code or Codex CLI — Fixy works immediately. No API keys to configure, no extra accounts to create, no AI provider setup. Fixy uses your existing sessions as-is.

---

## Requirements

Before installing Fixy Code, make sure you have at least one of these installed and authenticated:

| Agent | Install | Auth |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Codex CLI | `npm install -g @openai/codex` | `codex` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini` |

You need Node.js 20 or higher. Works on macOS, Linux, and Windows.

---

## Install

```bash
npm install -g @fixy/code
```

---

## Start

Run `fixy` from inside any git repository:

```bash
cd your-project
fixy
```

That's it. Fixy detects which agents you have installed and shows them in the header.

---

## Update

Fixy checks for updates automatically every time you start it. If a new version is available, you will see:

```
  ℹ  Fixy v0.0.8 Available — Update Now? (Y/n)
```

Press `y` to update and restart automatically. Press `n` to skip and continue.

To update manually:

```bash
npm install -g @fixy/code
```

To uninstall:

```bash
npm uninstall -g @fixy/code
```

---

## Commands

### Talk to agents

```
@claude <message>         — send a message to Claude Code
@codex <message>          — send a message to Codex CLI
@gemini <message>         — send a message to Gemini CLI
@claude @codex <message>  — send to multiple agents at once
<message>                 — send to your default worker (no @ needed)
```

### File references

Include file content in your prompt with `@path`:

```
@claude review @./src/auth.ts for security issues
@codex refactor @./utils/helper.ts
explain @./package.json
```

Files with `/` or starting with `.` are treated as file references, not agent mentions.

### Shell commands

Run shell commands directly with `!`:

```
!git status
!ls -la src/
!npm test
```

### Collaboration

```
/all <task>               — all agents collaborate (auto-detects question vs task)
/all! <task>              — force full pipeline (skip question detection)
/agents                   — list agents, enable/disable for @all
/agents enable <name>     — include agent in @all
/agents disable <name>    — exclude agent from @all
/red-room                 — show current mode (on/off)
/red-room on              — enable adversarial mode
/red-room off             — disable adversarial mode
/review                   — review code changes with all agents
/review --staged          — review only staged changes
/review @claude           — use specific agent to review
```

### Model selection

```
/model                    — change model for current worker
/model @claude            — change Claude's model
/model @codex             — change Codex's model
/model @gemini            — change Gemini's model
```

You can type a number from the list or a model name directly. Both aliases and full model IDs work:

```
haiku                     — alias for latest Haiku
sonnet                    — alias for latest Sonnet
opus                      — alias for latest Opus
claude-opus-4-6           — full model ID
claude-haiku-4-5-20251001 — full model ID with date
```

The model applies to the adapter everywhere — both direct `@agent` calls and worker calls use the same model.

### Session management

```
/worker                   — show/change default worker
/new                      — create a new session
/threads                  — list and switch sessions
/rename <name>            — give current session a name
/fork                     — fork current session (copy history to new thread)
/status                   — show agents, models, and session info
/stats                    — show token usage and session statistics
```

### Utility commands

```
/diff                     — show git diff and untracked files
/copy                     — copy last response to clipboard
/clear                    — clear terminal screen
/compact                  — reset adapter session
/settings                 — view global settings
/settings set <key> <val> — update a setting
/shortcuts                — show all keyboard shortcuts
/help                     — show all commands and usage
/quit                     — exit Fixy
```

### Account

```
/login                    — sign in to fixy.ai
/logout                   — sign out
/account                  — view plan and usage
/upgrade                  — open plan management in browser
```

### Keyboard shortcuts

```
Enter                     — submit message
Alt+Enter                 — new line (multi-line input)
\ at end of line          — continue on next line
ESC                       — cancel running turn or clear input
Ctrl+T                    — toggle thinking display on/off
Ctrl-C                    — cancel turn; press again to exit
/                         — show command menu (with arrow navigation)
@                         — show agent menu
Tab                       — accept autocomplete selection
Up/Down                   — navigate menu
```

---

## Red Room mode

Red Room is Fixy's adversarial collaboration mode. When enabled, the second agent is instructed to find everything wrong with the first agent's proposal — not to agree, but to break it.

When two agents genuinely disagree, Fixy shows you a choice panel:

```
╭──────────────────────────────────────────────────────╮
│  ⚔  AGENTS DISAGREE — YOU DECIDE                     │
│                                                        │
│  @claude: use JWT refresh tokens (stateless)          │
│  @codex:  use session cookies (simpler, more secure)  │
│                                                        │
│  1. Go with @claude   2. Go with @codex               │
│  3. Ask them to find a middle ground                   │
╰──────────────────────────────────────────────────────╯
```

Type `1`, `2`, or `3`. You decide.

Enable it:
```
@fixy /red-room on
```

Or set it as your global default:
```
/settings set redRoomMode true
```

---

## Global settings

Settings are stored in `~/.fixy/settings.json`. You can edit this file directly or use the `/settings` command.

| Setting | Default | Description |
|---|---|---|
| `defaultWorker` | `claude` | Which agent handles bare prompts |
| `collaborationMode` | `standard` | `standard`, `critics`, `red_room`, or `consensus` |
| `redRoomMode` | `false` | Shorthand for enabling adversarial mode |
| `reviewMode` | `auto` | `auto`, `ask_me`, or `manual` |
| `maxDiscussionRounds` | `3` | How many rounds agents discuss before deciding |
| `maxReviewRounds` | `2` | How many review passes after execution |
| `maxTodosPerBatch` | `5` | How many tasks agents execute per batch |
| `claudeModel` | `""` | Model for Claude (e.g. `haiku`, `sonnet`, `opus`, or full ID) |
| `codexModel` | `""` | Model for Codex (e.g. `gpt-5.4`) |
| `geminiModel` | `""` | Model for Gemini (e.g. `gemini-3.1-pro-preview`) |
| `claudeArgs` | `""` | Extra CLI flags passed to Claude on every call |
| `codexArgs` | `""` | Extra CLI flags passed to Codex on every call |
| `geminiArgs` | `""` | Extra CLI flags passed to Gemini on every call |
| `agentTimeout` | `120` | Per-agent timeout in seconds for @all parallel execution |
| `showThinking` | `true` | Show real-time thinking and tool activity lines |
| `workerModelOverride` | `""` | Separate model for @worker (e.g. `haiku` while @claude uses `opus`) |
| `disabledAdapters` | `[]` | Agents excluded from @all broadcasts |

### Per-conversation overrides

You can override any agent's flags for just the current conversation:

```
@fixy /set claude --dangerously-skip-permissions
@fixy /set codex --full-auto
```

These are not saved globally — they apply only to the current session.

---

## Pricing

| Plan | Price | What you get |
|---|---|---|
| **Free** | $0 | Full access on day one. After that: 3 active threads, 1 project, 30-day history, terminal only, no background automations, community support |
| **Pro** | $10/user/month | Unlimited threads, unlimited projects, 90-day history, background automations, all clients (terminal + desktop + VS Code when built), email support |
| **Team** | $20/workspace/month | Everything in Pro + up to 5 seats, shared workspaces, shared history, audit logs, admin controls, priority support |
| **Business** | Custom | Everything in Team + unlimited seats, SSO, on-premise option, SLA, dedicated support, custom integrations |

**Fixy never charges per @mention call, agent-to-agent turn, or adapter connection.** One task = one thread, however many agents it uses internally.

For more information: [fixy.ai/code](https://fixy.ai/code)

---

## Privacy

- Your code never leaves your machine
- Fixy never sees your API keys or credentials — agents use their own auth
- All thread history is stored locally in `~/.fixy/`
- Fixy Code is open source (MIT)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the project locally.

---

## License

MIT — Copyright © Fixy AI
