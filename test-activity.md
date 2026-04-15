# Fixy Code

Fixy Code is a terminal application that hosts a shared conversation where a user's already-installed coding agents (such as Claude Code and Codex CLI) can be addressed via `@mention`. Agents can review, critique, and improve each other's work within a single unified thread.

Fixy Code ships no models of its own. It spawns the user's existing CLI tools as subprocesses with inherited authentication, and relays messages between them. Each agent operates in its own git worktree for isolation, while the orchestration layer coordinates their collaboration.

## Key Details

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Architecture:** pnpm monorepo with packages for core, CLI, adapter utilities, and provider-specific adapters
- **npm scope:** `@fixy`
- **Install:** `npm install -g @fixy/code`
- **Platform:** macOS first, Linux compatible, Windows out of scope for v0
- **License:** MIT
