# @fixy/code

Terminal REPL for Fixy Code — orchestrate installed coding agents in one conversation.

## Install

```sh
npm install -g @fixy/code
```

## Usage

```sh
cd your-git-repo
fixy
```

This opens an interactive REPL bound to a thread in the current git repository.

## Talking to agents

```
fixy> @claude refactor the top of README.md for brevity
fixy> @claude once more, even shorter
fixy> @fixy /status
fixy> /quit
```

- `@claude <message>` — talk to Claude Code
- `@fixy /status` — show adapter status
- `@fixy /worker <adapter>` — change worker model
- `@fixy /reset` — reset thread sessions and worktrees
- `/quit` or `/exit` — exit the REPL
- `Ctrl-C` — cancel current turn or exit when idle

## Flags

- `--thread <id>` — resume an existing thread

## Requirements

- Node.js 20+
- Claude Code CLI installed and logged in (`claude login`)
