# Fixy Code

Local orchestration layer for installed coding agents (Claude Code, Codex, and more).

**Use your existing coding agents. Fixy coordinates them.**

## What it does

Fixy Code sits between your locally installed coding agents — Claude Code, Codex CLI, and others — and lets them collaborate on one task in one shared conversation. Each agent uses its own auth, its own tools, its own plugins. Fixy Code just routes messages, manages isolated workspaces, and helps you pick the best result.

- `@claude` — talk to Claude Code
- `@codex` — talk to Codex CLI
- `@fixy` — reserved commands (verdict, worker model, status)

One conversation. Multiple agents. Your existing subscriptions.

## Status

**Pre-release** — actively being built. See [IMPLEMENTATION-PLAN-FIXYCODE.md](IMPLEMENTATION-PLAN-FIXYCODE.md) for the full roadmap.

## License

MIT

## Development

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- pnpm 9+

### Setup

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
```

### Project structure

```
packages/
  core/             — shared types, interfaces, and utilities
  adapter-utils/    — helpers for spawning and managing adapter subprocesses
  cli/              — terminal REPL entry point (@fixy/code)
  claude-adapter/   — Claude Code adapter (@fixy/claude-adapter)
  codex-adapter/    — Codex CLI adapter (@fixy/codex-adapter)
```
