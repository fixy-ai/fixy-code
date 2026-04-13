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

---

## No login required

If you're already logged into Claude Code, Codex CLI, or Gemini CLI — Fixy works immediately. No API keys to configure, no extra accounts to create, no AI provider setup. Fixy uses your existing sessions as-is.

---

## Requirements

Before installing Fixy Code, make sure you have at least one of these installed and authenticated:

| Agent | Install | Auth |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Codex CLI | `npm install -g @openai/codex` | `codex` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini` |

You need Node.js 20 or higher.

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
```

### Fixy commands

```
@fixy /all <task>         — all agents collaborate on one task (discuss → plan → execute → review)
@fixy /worker <agent>     — set which agent handles bare prompts (default: claude)
@fixy /status             — show which agents are available and their current models
@fixy /red-room on        — enable adversarial mode (agents challenge each other aggressively)
@fixy /red-room off       — disable adversarial mode
@fixy /set <agent> <flags>  — pass custom CLI flags to a specific agent for this conversation
```

### Conversation commands

```
/compact                  — summarize the conversation so far (saves context for long sessions)
/compact @claude          — use Claude specifically to summarize
/settings                 — view your global settings
/settings set <key> <value>  — update a setting
/settings reset           — restore all settings to defaults
/quit                     — exit Fixy
```

### Keyboard shortcuts

```
ESC                       — cancel a running agent turn, or clear the current input line
Ctrl-C                    — cancel a running turn; press again to exit
/  (at empty prompt)      — show command menu
@  (at empty prompt)      — show agent menu
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
│  [1] Go with @claude   [2] Go with @codex             │
│  [3] Ask them to find a middle ground                  │
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
| `claudeArgs` | `""` | Extra CLI flags passed to Claude on every call |
| `codexArgs` | `""` | Extra CLI flags passed to Codex on every call |
| `geminiArgs` | `""` | Extra CLI flags passed to Gemini on every call |

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
| **Free** | $0 | Full access on day one. After that: 3 active threads, 1 project, 30-day history, terminal only |
| **Pro** | $10/month | Unlimited threads, unlimited projects, full history, all clients (terminal + desktop + VS Code when available) |
| **Team** | $20/workspace/month | Everything in Pro + shared workspaces, shared history, audit logs, admin controls (up to 3 seats) |

**Fixy never charges per agent call, per mention, or per turn.** One task = one thread, however many agents it uses internally.

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
