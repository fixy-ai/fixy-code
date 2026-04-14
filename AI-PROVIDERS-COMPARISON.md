# AI Provider CLI Comparison & Fixy Improvement Opportunities

A detailed analysis of Claude Code, Codex CLI, and Gemini CLI features compared to Fixy's current implementation. Each section explains what the providers do, what Fixy currently has, and what we can bring in.

---

## Table of Contents

1. [Slash Commands](#1-slash-commands)
2. [@ Mentions & File References](#2--mentions--file-references)
3. [Model Selection](#3-model-selection)
4. [Autocomplete & Dropdown Menus](#4-autocomplete--dropdown-menus)
5. [Keyboard Shortcuts](#5-keyboard-shortcuts)
6. [Session & Thread Management](#6-session--thread-management)
7. [Settings & Configuration](#7-settings--configuration)
8. [Permission & Approval System](#8-permission--approval-system)
9. [Input Handling](#9-input-handling)
10. [Output & Display](#10-output--display)
11. [Skills, Plugins & Extensions](#11-skills-plugins--extensions)
12. [MCP (Model Context Protocol)](#12-mcp-model-context-protocol)
13. [Collaboration & Multi-Agent](#13-collaboration--multi-agent)
14. [Shell Integration](#14-shell-integration)
15. [Authentication](#15-authentication)
16. [Priority Improvement List](#16-priority-improvement-list)

---

## 1. Slash Commands

### What the providers do

**Claude Code** uses a file-based command system. Commands are markdown files stored in `.claude/commands/` (project), `~/.claude/commands/` (personal), or inside plugins. Each command file has YAML frontmatter with fields like `description`, `allowed-tools`, `model`, `argument-hint`, and `disable-model-invocation`. Commands support arguments via `$1`, `$2`, `$ARGUMENTS` placeholders and can include file content with `@path`. Commands can be namespaced: `/ci/build` from a `ci/` subdirectory. There are no hardcoded built-in commands in the plugin layer — all commands come from files.

**Codex CLI** has 47 hardcoded built-in slash commands defined in Rust (`slash_command.rs`). Key ones:
- `/model` — pick model and reasoning effort
- `/fast` — toggle fast inference (2x plan usage)
- `/approvals` or `/permissions` — configure approval policies
- `/skills` — browse and use skills
- `/review` — review current changes
- `/new`, `/resume`, `/fork` — thread management
- `/compact` — summarize conversation
- `/plan` — switch to plan-only mode
- `/collab` — change collaboration mode
- `/agent` or `/subagents` — switch between agent threads
- `/copy` — copy last response as markdown
- `/diff` — show git diff
- `/mention` — mention a file
- `/status` — show session config and token usage
- `/mcp` — list MCP tools
- `/plugins` — browse plugins
- `/theme` — syntax highlighting theme
- `/statusline`, `/title` — configure footer and terminal title
- `/quit` or `/exit`
- `/feedback` — send logs to maintainers
- `/ps` — list background terminals
- `/stop` or `/clean` — stop background terminals
- `/clear` — clear terminal and start new chat
- `/personality` — communication style
- `/realtime` — voice mode
- `/init` — create AGENTS.md

Commands have aliases (e.g. `/quit` = `/exit`, `/stop` = `/clean`, `/approvals` = `/permissions`, `/agent` = `/subagents`). Some commands are feature-gated and only appear when the capability is enabled.

**Gemini CLI** has the most extensive command set with 40+ commands defined in TypeScript (`/packages/cli/src/ui/commands/`). Key additions beyond what others have:
- `/memory` — interact with GEMINI.md memory files (show, add, reload, list, inbox)
- `/skills` — manage skills (list, link, enable, disable, reload)
- `/commands` — reload custom commands from .toml files
- `/agents` — manage agents (list, enable, disable)
- `/resume` or `/chat` — save/load conversation checkpoints with tags
- `/extensions` — manage extensions (list, explore, update, config)
- `/permissions trust` — folder trust system
- `/vim` — toggle vim keybindings
- `/tasks` or `/bg` — background tasks panel
- `/shortcuts` — toggle shortcuts help panel
- `/stats` — session statistics (token usage)
- `/compress` — compress conversation history
- `/hooks` — manage hook system
- `/editor` — configure external editor
- `/theme` — UI themes
- `/copy` — copy to clipboard
- `/bug` — report a bug
- `/corgi` — easter egg

Many commands have subcommands (e.g. `/mcp list`, `/mcp auth`, `/mcp enable`).

### What Fixy currently has

16 commands: `/worker` (`/w`), `/all` (`/a`), `/settings`, `/reset`, `/status` (`/st`), `/compact`, `/red-room`, `/set`, `/model` (`/m`), `/login`, `/logout`, `/new` (`/n`), `/threads` (`/t`), `/help` (`/h`), `/account`, `/upgrade`. Plus `/quit` (`/q`) handled in the REPL.

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `/diff` | Codex | Show git diff of changes made during session. Very useful for reviewing what the agent changed. |
| `/copy` | Codex, Gemini | Copy last agent response as markdown to clipboard. Users constantly want to share agent output. |
| `/plan` | Codex, Gemini | Switch to plan-only mode where agent proposes but does not execute. Safety feature. |
| `/clear` | Codex, Gemini | Clear terminal screen and optionally start fresh chat (different from `/new` which creates a thread). |
| `/stats` | Gemini | Show token usage, message count, time elapsed. Users want to know how much they are spending. |
| `/init` | Codex | Create a project guidance file (like AGENTS.md or FIXY.md) with project conventions for the agent. |
| `/rename` | Codex | Rename current thread. Currently threads have auto-generated IDs. |
| `/fork` | Codex | Fork current conversation into a new thread, keeping history. |
| `/compress` | Gemini | Compress/summarize conversation to save tokens (like `/compact` but for all agents). |
| `/vim` | Gemini | Toggle vim keybindings in input. Developers love this. |
| `/shortcuts` | Gemini | Show available keyboard shortcuts as a help panel. |
| `/bug` | Gemini | Quick bug report — opens a template or sends logs. |
| Subcommands | Gemini | Commands like `/mcp list`, `/mcp auth`. Currently all our commands are flat. |
| Feature-gating | Codex | Hide commands that are not available (e.g. don't show `/upgrade` to Pro users). |

---

## 2. @ Mentions & File References

### What the providers do

**Claude Code** uses `@path` syntax inside command files to include file contents in the prompt. For example, a command file can say `Review @$1 for vulnerabilities` and when the user runs `/review src/auth.ts`, the file content is injected. This is a static, template-level inclusion — not a runtime REPL feature.

**Codex CLI** has rich @ mention support in the REPL:
- Type `@` to trigger a file search popup showing project files
- Fuzzy matching on file names with match highlighting
- Up to 16 results shown
- Files are included as context in the message sent to the agent
- Also supports `$` prefix for tool/skill mentions and `[Image #N]` for image attachments
- Mention items have `display_name`, `description`, `search_terms`, `category_tag`, `sort_rank`

**Gemini CLI** has the most powerful @ system:
- `@./path/to/file` — include specific file
- `@./directory/` — include all files in directory (with glob expansion)
- `@resource-uri` — include MCP resources
- `@agent-name` — delegate task to specific agent
- Respects `.gitignore` and `.geminiignore`
- Permission checks before reading files
- Handles escaped `@` with `\@`
- Completion suggestions while typing the path

### What Fixy currently has

`@agent` mentions to route messages to specific agents (e.g. `@claude`, `@codex`, `@gemini`). The `@` triggers an autocomplete dropdown showing available agents. No file inclusion support.

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `@file` references | Codex, Gemini | Let users type `@path/to/file` to include file content in the prompt sent to the agent. The agent gets the file content as additional context. This is the single most requested feature in AI coding CLIs. |
| File search popup | Codex | When user types `@` followed by text, show a fuzzy file search popup (separate from the agent mention popup). Detect whether user is typing an agent name or a file path. |
| Directory inclusion | Gemini | `@./src/` includes all files in a directory. Useful for giving an agent context about an entire module. |
| `.gitignore` respect | Gemini | When expanding file references, skip files in `.gitignore`. |
| Mixed mentions | All | Support both `@agent` and `@file` in the same message. For example: `@claude review @src/auth.ts for security issues`. |

---

## 3. Model Selection

### What the providers do

**Claude Code** allows model override per command via frontmatter (`model: opus`). Three tiers: `haiku` (fast), `sonnet` (balanced), `opus` (complex). No interactive model picker in the plugin system.

**Codex CLI** has an interactive `/model` command that:
- Opens a selection popup showing available models (based on user's plan tier)
- Lets user choose reasoning effort level (low, standard, high)
- Has `/fast` toggle for 2x speed at 2x plan cost
- Model + effort persist per thread via `OverrideTurnContext`
- Shows model info in `/status` output

**Gemini CLI** has the richest model selection:
- `/model set <model-name>` — switch model for current session
- `/model set <model-name> --persist` — save choice permanently
- `/model manage` — opens interactive dialog with quota information
- Shows quota limits (requests/min, requests/day) before selection
- Model names typed directly (not numbers)
- Session vs permanent distinction is clear

### What Fixy currently has

`/model` command that:
- Lists available models from the current worker's adapter
- User types model name or number
- Prompts for reasoning effort (for Claude)
- Asks whether to save globally
- Uses a 3-tier approach for model discovery (fixy.ai API, provider API, current active model)

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `--persist` flag | Gemini | `/model set gpt-4o --persist` instead of a separate "Save globally?" prompt. One-line command. |
| `/fast` toggle | Codex | Quick toggle for fast/quality tradeoff without going through model selection. Maps to reasoning effort or model tier. |
| Quota display | Gemini | Show remaining quota/usage before model selection so users know what they can pick. |
| Per-thread model | Codex | Each thread remembers its model. Currently Fixy has `workerModel` on threads but model selection could be more explicit. |
| Model in status | Codex | `/status` should clearly show current model + effort level for each worker. |

---

## 4. Autocomplete & Dropdown Menus

### What the providers do

**Claude Code** uses `argument-hint` in command frontmatter for shell completion hints and `AskUserQuestion` tool for interactive multi-choice menus during command execution. No REPL-level autocomplete dropdown.

**Codex CLI** has three popup types:
1. **Command popup** — triggered by `/`, shows matching commands with descriptions, exact > prefix matching, hides aliases to avoid duplicates
2. **File search popup** — triggered by `@`, async fuzzy file search, shows up to 16 results with match highlighting, caches results while new search is in flight
3. **Skill/tool popup** — triggered by `$`, fuzzy match on display_name + search_terms, category tags, sorted by rank

All popups: arrow keys to navigate, Enter to select, Esc to close. Maximum 16 visible rows.

**Gemini CLI** has a completion system with 5 modes:
- `IDLE` — no suggestions
- `AT` — file/resource/agent path completion
- `SLASH` — slash command completion with hierarchical subcommand support
- `PROMPT` — prompt template completion
- `SHELL` — shell command completion

Features: suggestions display above or below input (configurable), grouped by label, rich formatting, auto-execute capability for some commands, argument completion callbacks for dynamic suggestions.

### What Fixy currently has

- `/` triggers a slash command menu with arrow key navigation and highlighted selection
- `@` triggers an agent mention menu
- Case-insensitive matching
- Partial command auto-resolve (e.g. `/qu` becomes `/quit` on Enter)
- Single autocomplete mode — no file search or tool mentions

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| File search popup | Codex | When `@` is followed by a path character (`/`, `.`, or after space), switch from agent menu to async file search. Show fuzzy-matched project files. |
| Subcommand completion | Gemini | When user types `/model `, show subcommand suggestions (e.g. `set`, `manage`, `list`). |
| Command descriptions in popup | Codex | Show short descriptions next to each command in the `/` menu. We already have this but can improve formatting. |
| Result caching | Codex | Cache file search results while a new search is in flight, so the popup does not flicker empty. |
| Category grouping | Gemini | Group suggestions by type — "Commands", "Agents", "Files" — with section headers in the dropdown. |
| Auto-execute | Gemini | Some commands like `/help`, `/status` auto-execute on selection without needing Enter. |

---

## 5. Keyboard Shortcuts

### What the providers do

**Claude Code** supports keybindings via `.claude/keybindings.json` but specific defaults are in the main binary, not documented in the plugin layer.

**Codex CLI** has these key shortcuts:
- `Enter` — submit message
- `Shift+Enter` or `Tab` — insert newline
- `Esc` — close popup / restore previous draft
- `Up/Down` — navigate history or popup
- `Ctrl+R` — reverse history search
- `Ctrl+C` — clear input + stash to history
- `Ctrl+K` — kill (cut) to end of line
- `Ctrl+Y` — yank (paste) from kill buffer
- `Ctrl+V` — paste image from clipboard
- `Ctrl+O` — copy last response as markdown
- `Alt+Left/Right` — switch between agent threads
- `?` — toggle shortcut overlay

**Gemini CLI** has the most extensive keybinding system, fully data-driven and rebindable:
- All standard cursor movement (Home/End, word jump with Ctrl/Alt+arrows)
- `Ctrl+K` / `Ctrl+U` — kill line right/left
- `Ctrl+W` — delete word backward
- `Ctrl+R` — reverse history search
- `Ctrl+Enter` — queue message while agent is busy
- `Shift+Enter` — newline
- `Ctrl+X, Ctrl+E` — open external editor
- `Ctrl+V` — paste from clipboard (including images)
- Toggle shortcuts: markdown preview, copy mode, mouse mode, YOLO (auto-approve) mode, approval mode cycling
- Background shell controls: toggle, select, kill
- All bindings stored in a `KeyBindingConfig` map and user-customizable

### What Fixy currently has

- `Enter` — submit
- `Up/Down` — navigate autocomplete menu
- `Esc` — cancel/dismiss
- `Tab` — (default readline behavior)
- Basic readline shortcuts (Ctrl+A, Ctrl+E, etc. from Node.js readline)

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `Ctrl+C` to clear input | Codex | Instead of exiting, clear the current input line. Double Ctrl+C to exit. More forgiving. |
| `Shift+Enter` for newline | Codex, Gemini | Multi-line input support. Users often want to write multi-line prompts. |
| `Ctrl+R` reverse search | Codex, Gemini | Search through input history. Standard terminal feature that power users expect. |
| `Ctrl+K` / `Ctrl+U` kill line | Gemini | Standard readline line-editing shortcuts. May already work via Node readline. |
| Copy last response | Codex | `Ctrl+O` or `/copy` to copy the last agent response to clipboard. Very useful. |
| `/shortcuts` help panel | Gemini | Show all available shortcuts in a reference panel so users can learn them. |
| Message queuing | Gemini | `Ctrl+Enter` to queue a message while the agent is still working. It runs after the current turn finishes. |

---

## 6. Session & Thread Management

### What the providers do

**Claude Code** manages sessions through hook events (`SessionStart`, `SessionEnd`) and plugin state files (`.claude/plugin-name.local.md`). Threads are managed by the main application, not the plugin layer.

**Codex CLI** has robust thread management:
- `/new` — start new session (old one is resumable)
- `/resume` — resume by UUID or name
- `/fork` — fork current thread into a new one keeping history
- `/rename` — rename current thread
- `/clear` — clear UI and start fresh
- Subagent threads: parent-child relationships, tree structure, breadth-first discovery
- Navigation between threads: `/agent` picker or `Alt+Left/Right`
- Thread metadata: id, preview, status, cwd, agent_nickname, created_at, updated_at

**Gemini CLI** has conversation checkpointing:
- `/resume save <tag>` — save conversation with a human-readable tag name
- `/resume list` — list saved checkpoints sorted by time
- `/resume resume <tag>` — restore a conversation from checkpoint
- Validates that auth method has not changed between save and resume
- Overwrite confirmation when saving to existing tag
- Auto-save for crash recovery
- Session tracking with unique IDs per session
- `/clear` generates a new session ID

### What Fixy currently has

- `/new` — create new thread (with plan limit enforcement)
- `/threads` — list threads with interactive selection (shows recent 6 messages after switch)
- Thread ID displayed at startup
- Thread worker model stored per thread
- Free plan limited to 1 session

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `/rename` | Codex | Let users give threads human-readable names instead of UUIDs. `/rename "auth refactor"`. |
| `/fork` | Codex | Fork current conversation — start a new thread but keep all history up to this point. Useful for exploring two approaches. |
| Tagged checkpoints | Gemini | `/save auth-work` and `/resume auth-work` instead of navigating by thread ID. Much more user-friendly. |
| Thread preview | Codex | Show a short preview of the conversation (first message or last message) in the thread list. |
| Thread status | Codex | Show thread status (active, idle, completed) in the list. |
| Alt+Left/Right switching | Codex | Quick keyboard shortcut to switch between recent threads without opening a menu. |

---

## 7. Settings & Configuration

### What the providers do

**Claude Code** uses plugin-level settings files (`.claude/plugin-name.local.md`) with YAML frontmatter. Settings are parsed with sed/grep in hooks. Global settings in `~/.claude/settings.json`.

**Codex CLI** has per-thread override settings for model, effort, summary, service_tier, collaboration_mode, personality. Also has `/statusline` and `/title` configuration for customizing the terminal display. Experimental features toggled via `/experimental`.

**Gemini CLI** has the most structured settings system:
- Interactive `/settings` dialog for browsing and editing all settings
- Two scopes: User level (`~/.gemini/settings.json`) and Workspace level (merged at runtime)
- Categories: `security.auth`, `experimental`, `ui`, `admin`, `mcp`, `agents`, `skills`
- Individual commands for specific settings (`/model`, `/theme`, `/editor`, `/auth`)
- Settings persistence with auto-save
- Config validation on load

### What Fixy currently has

- `/settings` command to view and `/set` to change settings
- Settings stored in `~/.fixy/settings.json`
- Fields: `defaultWorker`, `claudeArgs`, `codexArgs`, `geminiArgs`, `claudeModel`, `codexModel`, `geminiModel`
- Per-thread overrides for worker and adapter args

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Interactive settings dialog | Gemini | Instead of `/set key value`, show an interactive menu listing all settings with current values. User picks one to change. |
| Workspace-level settings | Gemini | A `.fixy/settings.json` in the project root that overrides user settings for that project. Teams can share project-specific config. |
| `/theme` | Codex, Gemini | Let users pick color themes for output. Some users prefer light terminal, some dark. |
| `/personality` | Codex | Communication style presets (concise, detailed, friendly, pragmatic). Changes the system prompt sent to agents. |
| Setting categories | Gemini | Group settings logically: "Workers", "Models", "Display", "Auth". Show in `/settings` with sections. |

---

## 8. Permission & Approval System

### What the providers do

**Claude Code** has tool-level permissions in commands (`allowed-tools: Read, Bash(git:*)`). Hooks can approve, deny, or ask user before any tool executes. `PreToolUse` hooks validate operations, `PostToolUse` hooks react to results.

**Codex CLI** has a sophisticated approval overlay system:
- Three approval types: Exec (shell commands), Patch (file edits), Permissions (file access, network)
- Four decisions: Approve, Deny, Always Allow, Never Allow
- Modal overlay UI with context, reason, and decision options
- Approval queue: stacks multiple requests, processes sequentially
- Configurable policies: "Always ask", "Never ask", "Ask when risky"
- MCP elicitation: MCP tools can request user input through the approval system

**Gemini CLI** uses a trust-based permission model:
- `/permissions trust [directory]` — trust/untrust folders for file access
- Admin controls can block MCP servers globally
- Three approval modes: `APPROVE_ALL` (auto), `MANUAL` (confirm each), `PLAN` (generate plan first)
- Keyboard shortcut to cycle through approval modes
- Extension actions require consent confirmation

### What Fixy currently has

- Claude adapter passes `--dangerously-skip-permissions` or not based on onboarding choice
- Per-adapter args can include permission flags
- No Fixy-level approval system — permissions delegated entirely to underlying CLIs

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Approval mode setting | Codex, Gemini | Let users set a Fixy-level approval preference: "always ask", "auto-approve", "plan first". Pass appropriate flags to each adapter. |
| `/plan` mode | Codex, Gemini | Agent proposes changes as a plan, user reviews and approves before execution. Safety net for sensitive codebases. |
| Quick toggle | Gemini | Keyboard shortcut or `/yolo` command to temporarily auto-approve everything (for rapid prototyping). |
| Permission display | Codex | Show what permissions each agent currently has in `/status` output. |

---

## 9. Input Handling

### What the providers do

**Claude Code** — not documented at plugin level. Core application handles input.

**Codex CLI** has advanced input handling:
- Multi-line input: `Shift+Enter` or `Tab` to insert newlines
- Kill buffer: `Ctrl+K` to cut, `Ctrl+Y` to paste (persists after submit)
- Image paste: `Ctrl+V` detects image format by magic bytes, creates placeholder
- Large paste detection: text >1000 chars becomes `[Paste #N]` placeholder
- Paste burst detection (Windows): buffers rapid keypresses into single paste event
- Input history: `Up/Down` to recall, `Ctrl+R` for reverse search
- `Ctrl+C` clears input and stashes to history (does not exit)
- Tab during task = queue message for later
- `!command` syntax for direct shell execution

**Gemini CLI** has the richest input system:
- Multi-line with `Shift+Enter`
- Vim mode toggle (`/vim`)
- External editor: `Ctrl+X, Ctrl+E` opens system editor for composing long messages
- Clipboard paste including images
- Message queuing: `Ctrl+Enter` queues while agent is busy
- Copy mode: read-only text selection for copying output
- Mouse mode: toggle mouse interaction
- Reverse search: `Ctrl+R` with incremental matching
- Large paste handling with expand capability
- Shell command prefix: content starting with shell markers

### What Fixy currently has

- Single-line input via Node.js readline
- `Enter` to submit
- `Esc` to cancel
- Basic readline editing (Ctrl+A, Ctrl+E, arrow keys)
- Input history via readline
- Autocomplete menu with arrow navigation

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Multi-line input | Codex, Gemini | `Shift+Enter` to add a newline. Essential for writing detailed prompts. Requires raw mode keypress detection (we already have some of this). |
| External editor | Gemini | `Ctrl+E` opens `$EDITOR` (vim, nano, etc.) for composing long prompts. User writes in their editor, saves, and the content becomes the message. |
| `!command` shell execution | Codex | Type `!ls` to run a shell command directly without going through an agent. Quick utility. |
| Image/file paste | Codex, Gemini | `Ctrl+V` to paste clipboard content (images, large text) and include as context. Requires terminal image protocol support. |
| Message queuing | Gemini | Type a message while agent is working; it queues and sends after the current turn finishes. Currently users must wait. |
| `Ctrl+C` clears input | Codex | Instead of exiting, clear the line. Double Ctrl+C to exit. Prevents accidental exits. |
| Input history search | Codex, Gemini | `Ctrl+R` for reverse incremental search through input history. Standard terminal feature. |

---

## 10. Output & Display

### What the providers do

**Claude Code** — output handling is in the main binary. Plugins don't control display.

**Codex CLI** has structured output display:
- Different icons for user/assistant/tool messages
- Syntax highlighting for code blocks
- Expandable tool call details
- Error messages in red
- Peak audio meter visualization (for voice mode)
- Progress indicators with animations
- Token count display
- Status line footer configurable via `/statusline`
- Terminal title configurable via `/title`

**Gemini CLI** has rich Ink-based (React for terminals) rendering:
- Full markdown rendering with syntax highlighting
- Toggle markdown preview on/off
- Copy mode for selecting and copying output
- Background task panel
- Grouped suggestion display
- Progress spinners and loading indicators
- Theme support (multiple color schemes)
- Keyboard shortcut help panel overlay

### What Fixy currently has

- Streaming colorized output (text = light gray, code = bright white, headings = bold, stderr = dim red)
- Code fence detection and toggle tracking
- Markdown stripping (bold, italic, bullets, headings, inline code)
- `── @agent ──` separator lines preserved with original colors
- Spinner during agent execution

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Syntax highlighting in code | Codex, Gemini | Currently code blocks are just bright white. Add language-aware syntax highlighting using a library like `cli-highlight`. |
| Token usage display | Codex, Gemini | Show token count after each response (input tokens, output tokens). Helps users understand costs. |
| Status line footer | Codex | A persistent footer showing: current worker, model, thread name, token usage. Always visible. |
| Theme system | Gemini | Let users pick from preset color themes. Store in settings. |
| Copy mode | Gemini | A mode where users can scroll output and select text for copying. Currently output scrolls past. |
| `/clear` screen | Codex, Gemini | Clear terminal screen without creating a new thread. Just visual cleanup. |
| Progress detail | Codex | Show what the agent is currently doing (reading files, running commands) instead of just a generic spinner. |

---

## 11. Skills, Plugins & Extensions

### What the providers do

**Claude Code** has the richest plugin architecture:
- Plugins: bundles of commands, agents, hooks, skills, MCP servers
- Plugin manifest: `plugin.json` with name, version, commands, agents, hooks, mcpServers
- Skills: markdown files with trigger phrases that auto-load when detected
- Agents: autonomous subagents with their own system prompts and tool restrictions
- Hooks: event-driven automation (PreToolUse, PostToolUse, SessionStart, etc.)
- File-based, discoverable, namespaced

**Codex CLI** has:
- `/skills` — browse and use skills
- `/plugins` — browse and install plugins
- `$` mention for skill/tool references in messages
- Skill metadata: display_name, description, search_terms, path, sort_rank
- Plugin capabilities shown in UI

**Gemini CLI** has:
- `/skills` — list, link, enable, disable, reload skills
- `/extensions` — list, explore (opens gallery), update, configure
- `/commands` — reload custom commands from .toml files
- `/agents` — list, enable, disable agents
- Skills linkable from local paths with scope (user or workspace)
- Extension gallery browseable in browser
- Extension update management with progress UI

### What Fixy currently has

No plugin, skill, or extension system. Fixy orchestrates three fixed adapters (Claude, Codex, Gemini).

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Custom commands | Claude, Gemini | Let users create `.fixy/commands/review.md` files that become `/review` commands. The command content is sent as a prompt to the current worker. Simple but powerful. |
| Project guidance file | Codex | `/init` creates a `FIXY.md` file with project conventions. The content is prepended to every prompt sent to agents. Like CLAUDE.md but for all agents through Fixy. |
| Skill/knowledge files | Claude, Gemini | Let users drop `.md` files in `.fixy/skills/` that auto-load when relevant keywords are detected. For example, a "database" skill loads when the user mentions database migrations. |

---

## 12. MCP (Model Context Protocol)

### What the providers do

**Claude Code** configures MCP servers via `.mcp.json` files (project or plugin level). Supports stdio, SSE, HTTP, WebSocket server types. MCP tools become available as functions during command execution. Environment variables supported with `${VAR}` syntax.

**Codex CLI** has `/mcp` command to list configured MCP tools. MCP elicitation allows servers to request user input through the approval overlay. Tools referenced with `$` mention prefix.

**Gemini CLI** has the most complete MCP management:
- `/mcp list` — list servers with status
- `/mcp auth [server]` — OAuth authentication per server
- `/mcp enable/disable [server] [--session]` — toggle per session or permanently
- `/mcp reload` — restart all servers
- Shows tools, prompts, and resources per server
- Auth status tracking (authenticated, expired, not-configured)
- Admin can globally block MCP

### What Fixy currently has

No MCP support. Fixy relies on each adapter's own MCP configuration (e.g. Claude Code has its own `.mcp.json`).

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| MCP passthrough | All | Fixy does not need its own MCP system — the underlying CLIs handle it. But `/mcp` could show what MCP servers each adapter has configured, as an informational command. |
| Shared MCP config | Claude | A `.fixy/.mcp.json` that Fixy passes to each adapter. One config, all agents get the same tools. |

---

## 13. Collaboration & Multi-Agent

### What the providers do

**Claude Code** has autonomous subagents spawned via the `Task` tool. Each agent has its own system prompt, model, tool restrictions, and color. Agents run in parallel. Tree structure of parent-child relationships.

**Codex CLI** has:
- `/collab` — change collaboration mode (experimental)
- `/agent` or `/subagents` — switch between active agent threads
- `Alt+Left/Right` — quick switch between agents
- Subagent threads: tree structure with parent-child, depth tracking
- Visual indicators: dot for active, dimmed for closed
- Footer shows current agent nickname

**Gemini CLI** has `/agents` command to list, enable, disable agents. Agents are tools that can be delegated to via `@agent-name` mentions.

### What Fixy currently has

This is Fixy's core differentiator:
- `@agent` mentions to route to specific agents (Claude, Codex, Gemini)
- `@all` to broadcast to all agents (simple mode for short prompts, 5-phase pipeline for complex tasks)
- Worker system: default agent for unmentioned messages
- Per-thread worker override
- Collaboration engine with disagreement detection
- `── @agent ──` separators between responses

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Agent status indicators | Codex | Show which agents are currently running/idle in the prompt or a status line. |
| Quick agent switch | Codex | `Alt+Left/Right` to cycle the default worker without typing `/worker`. |
| Agent enable/disable | Gemini | `/agents enable codex` / `/agents disable codex` to temporarily exclude an agent from `@all`. |
| Parallel response streaming | Codex | When using `@all`, stream responses from all agents simultaneously instead of sequentially. Show which agent is currently outputting. |
| Agent nicknames | Codex | Let users set custom names for agents (e.g. `@reviewer` = Claude with specific settings). |

---

## 14. Shell Integration

### What the providers do

**Codex CLI** has:
- `!command` prefix for inline shell execution
- `/ps` — list background terminals
- `/stop` or `/clean` — stop all background terminals
- `/diff` — show git diff
- Shell commands go through approval if configured

**Gemini CLI** has:
- `/tasks` or `/bg` — toggle background task panel
- Background shell sessions: toggle, select, kill
- Shell command completion mode
- Focus/unfocus embedded shell with keyboard shortcuts
- Multiple parallel shell executions

### What Fixy currently has

No direct shell integration. Users must use a separate terminal for shell commands.

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| `!command` execution | Codex | Type `!git status` to run a shell command and see output directly in Fixy. Quick utility without leaving the REPL. |
| `/diff` | Codex | Show current git diff — what changed during the session. Very useful for reviewing agent work. |
| `/git` shortcut | N/A | `/git status`, `/git log --oneline -5` etc. — common git commands without the `!` prefix. |

---

## 15. Authentication

### What the providers do

**Claude Code** — authentication handled by the main binary.

**Codex CLI** has `/logout` to log out. Authentication through OAuth.

**Gemini CLI** has:
- `/auth signin` (alias: `/auth login`) — open auth dialog
- `/auth signout` (alias: `/auth logout`) — clear credentials
- MCP-specific auth: `/mcp auth [server]` — OAuth per MCP server
- Auth method validation when resuming sessions
- Multiple auth methods supported

### What Fixy currently has

- `/login` — device code auth flow (CLI opens browser for OAuth)
- `/logout` — clear auth tokens
- Token expiry checking at startup
- Plan sync from server on startup
- `/account` — show current account info
- `/upgrade` — open upgrade page in browser

### What we can improve

| Feature | Source | Description |
|---------|--------|-------------|
| Auth status in startup panel | Gemini | Already done — Fixy shows auth info at startup. Good. |
| Session resume auth check | Gemini | When switching threads, verify the auth is still valid for that thread's plan. |
| Token refresh | Gemini | Instead of just detecting expired tokens, attempt to refresh them automatically. |

---

## 16. Priority Improvement List

Based on the analysis, here are the improvements ranked by impact and implementation effort:

### High Impact, Low Effort (Do First)

1. **`/diff`** — Show git diff. One command, calls `git diff`, displays output. 10 minutes to implement.
2. **`/copy`** — Copy last response to clipboard. Use `pbcopy` (macOS) / `xclip` (Linux). 15 minutes.
3. **`/clear`** — Clear terminal screen. Just `\x1b[2J\x1b[H`. 5 minutes.
4. **`/rename <name>`** — Rename current thread. Add a `name` field to thread, update store. 30 minutes.
5. **`/stats`** — Show token usage, message count. Track in thread metadata. 30 minutes.
6. **`!command` shell execution** — Detect `!` prefix, spawn child process, show output. 30 minutes.
7. **`/shortcuts`** — Print keyboard shortcut reference. Static text output. 10 minutes.
8. **Agent enable/disable** — `/agents disable codex` to exclude from `@all`. Add `disabledAgents` to settings. 30 minutes.

### High Impact, Medium Effort (Do Second)

9. **`@file` references** — Parse `@path` in messages, read file, append to prompt. Need to distinguish from `@agent`. 2-3 hours.
10. **Multi-line input** — Detect `Shift+Enter` in raw mode, insert newline instead of submitting. 2-3 hours.
11. **Message queuing** — Queue input while agent is running, send after turn completes. 1-2 hours.
12. **Token usage tracking** — Track input/output tokens per turn (requires adapter changes to report token counts). 2-3 hours.
13. **Status line footer** — Persistent bottom line showing worker, model, thread, tokens. 2-3 hours.
14. **`/fork`** — Clone current thread's messages into a new thread. 1-2 hours.
15. **Custom commands** — Load `.fixy/commands/*.md` files as slash commands. 3-4 hours.
16. **Project guidance file** — `/init` creates `FIXY.md`, content prepended to all prompts. 1-2 hours.

### Medium Impact, Higher Effort (Do Later)

17. **File search popup** — Async fuzzy file search triggered by `@` + path characters. 4-6 hours.
18. **External editor** — `Ctrl+E` opens `$EDITOR`, reads content on save. 2-3 hours.
19. **Syntax highlighting in code blocks** — Integrate a highlighting library. 4-6 hours.
20. **`/plan` mode** — Agent proposes changes without executing. Requires adapter-level support. 4-6 hours.
21. **Theme system** — Preset color schemes stored in settings. 3-4 hours.
22. **`Ctrl+C` clears input** — Switch from exit to clear, double Ctrl+C to exit. 1-2 hours.
23. **Reverse history search** — `Ctrl+R` incremental search. 3-4 hours.
24. **Subcommand completion** — Show subcommands after typing `/model `. Extend autocomplete system. 3-4 hours.
25. **Parallel `@all` streaming** — Stream all agent responses simultaneously. Major architecture change. 8+ hours.

---

## Feature Matrix

| Feature | Claude Code | Codex CLI | Gemini CLI | Fixy Now | Priority |
|---------|:-----------:|:---------:|:----------:|:--------:|:--------:|
| Slash commands | File-based | 47 built-in | 40+ built-in | 16 | - |
| Command aliases | Via naming | Yes | Yes | Yes | - |
| Subcommands | Via nesting | No | Yes | No | Medium |
| `@file` references | In commands | In REPL | In REPL | No | **High** |
| `@agent` mentions | No | Agent threads | Agent delegation | Yes | - |
| Model picker | Per-command | Interactive popup | Interactive dialog | Interactive | - |
| Reasoning effort | Per-command | Per-model | Per-model | Per-model | - |
| File search popup | No | Yes (async) | Yes (completion) | No | **High** |
| Command autocomplete | No | Yes (popup) | Yes (popup) | Yes (popup) | - |
| Multi-line input | N/A | Shift+Enter | Shift+Enter | No | **High** |
| Keyboard shortcuts | Configurable | 20+ shortcuts | 50+ rebindable | Basic | Medium |
| Thread management | Via hooks | Full (new/resume/fork/rename) | Checkpoints (save/load) | new/threads | **High** |
| Approval system | Tool-level hooks | Modal overlay | Trust + modes | Delegated | Low |
| Shell execution | Via hooks | `!command` | Background shells | No | **High** |
| Git diff | Via hooks | `/diff` | Via tools | No | **High** |
| Copy response | No | Ctrl+O | `/copy` | No | **High** |
| Token display | No | In status | `/stats` | No | **High** |
| Plugins/extensions | Full system | Yes | Yes | No | Low |
| Skills | File-based | Yes | Yes | No | Low |
| MCP integration | `.mcp.json` | Yes | Full management | No | Low |
| Custom commands | Core feature | No | `.toml` files | No | Medium |
| Themes | No | `/theme` | `/theme` | No | Low |
| Voice/audio | No | `/realtime` | No | No | Skip |
| Image input | Via tools | Ctrl+V paste | Ctrl+V paste | No | Low |
| External editor | No | No | Ctrl+X,E | No | Medium |
| Message queuing | No | Tab | Ctrl+Enter | No | Medium |
| Vim mode | No | No | `/vim` | No | Low |
| Status line | No | Configurable | No | No | Medium |
| Background tasks | No | `/ps`, `/stop` | `/tasks` panel | No | Low |
| Collaboration mode | Via agents | `/collab` | No | `@all` pipeline | - |
| Agent switching | Alt+arrows | Alt+arrows | `@agent` | `/worker` | Medium |
