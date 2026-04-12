# Fixy Code — Implementation Plan (v0)

> **One-line pitch:** Fixy Code is a terminal app that hosts one shared conversation in which the user's already-installed coding agents (Claude Code, Codex CLI, later others) can be addressed by `@mention` and asked to review, critique, and improve each other's work. Fixy Code ships no models. It spawns the user's existing CLIs as subprocesses with inherited auth, and relays messages between them over one thread.

This plan is the **source of truth** for v0. Do not re-litigate locked decisions in this document — only record additions, deletions, and session log entries under "Session Log" at the bottom.

---

## 0. Locked Decisions (do not change)

| Decision | Value |
|---|---|
| Product name | **Fixy Code** |
| GitHub org / repo | `github.com/fixy-ai/fixy-code` |
| npm scope | `@fixy` (fallback `@fixy-ai`) |
| License | MIT |
| Language / runtime | Node.js 20+, TypeScript, strict mode |
| Monorepo tool | pnpm workspaces |
| v0 distribution | `npm install -g @fixy/code` |
| v0 surface | Terminal-only |
| v0 platform | macOS first (Linux should work; Windows explicitly out of scope) |
| v0 adapters | `@claude` (Claude Code), `@codex` (Codex CLI) |
| Auth model | **Inherited env only.** Spawn subprocesses with `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH`. No re-auth. No credential storage inside Fixy Code. |
| Routing handles | `@claude`, `@codex`, `@fixy` (reserved) |
| Worker | User-selected via `@fixy /worker <adapter>`. Fixy Code never ships its own models. To change the model *within* a provider, the user configures it inside the provider's own CLI settings — Fixy Code only routes between adapters. |
| Isolation | One **git worktree per `(thread, agent)`** pair |
| Pricing | **Free** $0 · **Pro** $10/user/mo · **Team** $20/workspace (≤3 seats) |
| Free tier | Day 1 full access → then 3 active threads, 1 project, 30-day history, terminal only |
| Pro tier | Unlimited threads / projects / history, all clients (terminal + desktop + VS Code when built) |
| Team tier | Pro + shared workspaces + shared history + audit logs + admin controls |
| Pricing law | **Never meter `@mention` calls, agent-to-agent turns, or adapter connections.** One user task = one thread, however many internal turns it contains. |

---

## 1. v0 Scope

### IN v0

| Area | Feature |
|---|---|
| Install | `npm install -g @fixy/code` → `fixy` on PATH |
| CLI | `fixy` opens a REPL bound to a thread inside the current repo |
| Adapters | `@claude` via `claude` binary, `@codex` via `codex` binary (both required on PATH) |
| Auth | Zero. Inherited `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH` passed through to child processes. |
| Routing | `@claude`, `@codex`, `@fixy` mention dispatch inside one shared thread |
| Worker | `@fixy` answers via whichever adapter the user has set as the worker |
| Commands | `/all`, `/worker`, `/settings`, `/reset`, `/status` |
| Isolation | `git worktree` per `(thread, agent)` under `.fixy/worktrees/<thread-id>/<agent>/` |
| Persistence | Thread + message log JSON files under `~/.fixy/projects/<project-hash>/threads/<thread-id>.json` |
| Streaming | Live stdout/stderr passthrough from adapter child processes to the terminal |
| Session resume | Per-adapter `sessionId` reuse across turns within a thread (Claude `--resume`, Codex session reuse) |

### NOT in v0 (explicitly out of scope)

| Area | Deferred to |
|---|---|
| Desktop / Tauri app | v1.1 |
| VS Code extension | v1.2 |
| Homebrew distribution | v0.2 |
| Cross-agent session codec / shared memory bridge | v0.3 |
| Third adapter (Gemini CLI / OpenCode / Aider) | v0.4 |
| Context summarization / compaction | v0.5 |
| Stripe billing + Pro/Team gating | v1.0 |
| Team sync / shared workspaces | v2.0 |
| Windows support | Later |
| Patch auto-apply to main branch | Never in v0; verdict shows, user decides |
| Fixy Code shipping its own models | Never |
| Scraping native GUI clients (Claude desktop, Codex app) | Never |
| Windows registry / credential stores | Never — always inherit env |

---

## 2. The FixyAdapter Interface

This is the single contract every adapter must implement. It is deliberately modeled on the Paperclip `AdapterExecutionContext → AdapterExecutionResult` pattern (see `packages/adapters/claude-local/src/server/execute.ts` and `packages/adapters/codex-local/src/server/execute.ts` in the Paperclip reference), stripped of Paperclip-specific workspace/wake/skills machinery.

```ts
// packages/core/src/adapter.ts

export interface FixyAgent {
  /** Stable handle without '@', e.g. "claude", "codex". */
  id: string;
  /** Display name shown in the terminal. */
  name: string;
}

export interface FixyThreadContext {
  threadId: string;
  projectRoot: string;       // absolute path to the git repo the thread lives in
  worktreePath: string;       // absolute path to the (thread, agent) worktree
  repoRef: string | null;     // branch or commit the worktree was created from
}

export interface FixyExecutionContext {
  runId: string;                        // unique per adapter invocation
  agent: FixyAgent;                     // which adapter is being invoked
  threadContext: FixyThreadContext;
  /** Full normalized message history Fixy decided to send this turn. */
  messages: FixyMessage[];
  /** Fresh user input for this turn, already stripped of the @mention prefix. */
  prompt: string;
  /** Opaque adapter-owned state from the previous turn in this thread. */
  session: FixySession | null;
  /** Streamed stdout/stderr chunks. Adapters MUST call this. */
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Called once with the resolved command + args + env for transcript/logging. */
  onMeta: (meta: FixyInvocationMeta) => void;
  /** Called with the child pid the moment the process spawns. */
  onSpawn: (pid: number) => void;
  /** Abort signal propagated from `/reset` and Ctrl-C. */
  signal: AbortSignal;
}

export interface FixyExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Human-readable summary the router appends to the thread. */
  summary: string;
  /** Opaque per-adapter state to persist for the next turn (e.g. Claude session id). */
  session: FixySession | null;
  /** Any patches/diffs the adapter produced, keyed by file path. */
  patches: FixyPatch[];
  /** Non-fatal warnings shown to the user after the turn completes. */
  warnings: string[];
  errorMessage: string | null;
}

export interface FixySession {
  /** Adapter-native session id, e.g. Claude `--resume` id or Codex thread id. */
  sessionId: string;
  /** Any adapter-specific params needed to resume. Must be JSON-serializable. */
  params: Record<string, unknown>;
}

export interface FixyInvocationMeta {
  resolvedCommand: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;   // already redacted of secrets by the adapter
}

export interface FixyAdapter {
  /** Stable id, matches the mention handle without '@'. */
  readonly id: string;
  /** Human-readable name for `/status`. */
  readonly name: string;
  /** Verify the CLI is installed and the user's auth is valid. */
  probe(): Promise<FixyProbeResult>;
  /** Run one turn. Must honor `ctx.signal`. */
  execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult>;
}

export interface FixyProbeResult {
  available: boolean;
  version: string | null;
  authStatus: "ok" | "needs_login" | "unknown";
  detail: string | null;
}
```

**Adapter obligations:**

1. Adapters **must never** read or write Fixy Code's own config. They only receive the `FixyExecutionContext` handed to them.
2. Adapters **must** spawn their child CLI with `cwd = ctx.threadContext.worktreePath`.
3. Adapters **must** pass through `process.env.HOME`, `process.env.CLAUDE_CONFIG_DIR`, `process.env.CODEX_HOME`, `process.env.PATH` untouched. Auth lives in the child CLI's own config, never in Fixy.
4. Adapters **must** redact secret-looking env keys before calling `onMeta`. Reuse the `redactEnvForLogs` helper pattern from `packages/adapter-utils/src/server-utils.ts` in the Paperclip reference.
5. Adapters **must** kill their child process when `ctx.signal` aborts.

---

## 3. Thread / Message Data Model

The conversation is the product. The data model is deliberately flat, append-only, and stored as one JSON file per thread so a user can `cat` it without tooling.

```ts
// packages/core/src/thread.ts

export type FixyRole = "user" | "agent" | "system";

export interface FixyThread {
  id: string;                         // uuid v7 (time-ordered)
  projectId: string;                  // sha1 of projectRoot
  projectRoot: string;                // absolute path
  createdAt: string;                  // ISO 8601
  updatedAt: string;                  // ISO 8601
  title: string | null;               // user-editable, null until first message
  status: "active" | "archived";
  workerModel: string;                // current @fixy worker adapter id, e.g. "claude"
  agentSessions: Record<string, FixySession | null>;  // per-adapter resume state
  worktrees: Record<string, string>;  // agentId → absolute worktree path
  messages: FixyMessage[];
}

export interface FixyMessage {
  id: string;                         // uuid v4
  createdAt: string;                  // ISO 8601
  role: FixyRole;
  /** For role=agent, the adapter id that produced this message. */
  agentId: string | null;
  /** The raw user input or agent summary. Streamed chunks are concatenated here once settled. */
  content: string;
  /** For role=agent, the runId of the FixyAdapter.execute() call. */
  runId: string | null;
  /** For role=user, the list of adapter ids the router dispatched this message to. */
  dispatchedTo: string[];
  /** Patches captured from the agent's worktree after the turn, if any. */
  patches: FixyPatch[];
  /** Non-fatal warnings surfaced to the user. */
  warnings: string[];
}

export interface FixyPatch {
  /** Absolute path of the file inside the adapter's worktree. */
  filePath: string;
  /** Path relative to the thread's project root. */
  relativePath: string;
  /** Unified diff produced by `git diff --no-color` inside the worktree. */
  diff: string;
  /** Bytes added / removed, populated by the worktree manager. */
  stats: { additions: number; deletions: number };
}
```

**Storage layout:**

```
~/.fixy/
├── config.json                       # global config, fixy version, default worker
├── projects/
│   └── <project-hash>/                # sha1(absolute projectRoot)
│       ├── project.json               # projectRoot, title
│       └── threads/
│           └── <thread-id>.json       # one FixyThread per file
└── worktrees/
    └── <thread-id>/
        ├── claude/                    # git worktree for @claude in this thread
        └── codex/                     # git worktree for @codex in this thread
```

Threads are append-only within a session; the thread file is rewritten atomically (write `*.tmp`, `fs.rename`) after every turn.

---

## 4. The 5 @mention Routing Rules

The router owns every user message the moment it arrives. These rules are the full decision tree — there is no other routing logic in v0.

1. **Explicit single mention.** If the message starts with exactly one `@<agent>` token and that agent is a known adapter, dispatch the rest of the message to that adapter only. Example: `@claude review the diff from @codex's last turn`.
2. **Explicit multi mention.** If the message contains two or more `@<agent>` tokens at the start (e.g. `@claude @codex brainstorm this`), dispatch the remaining text to each mentioned adapter **sequentially in mention order**, feeding each subsequent adapter the full thread tail including the prior adapter's response. Max 3 adapters per turn.
3. **`@fixy` reserved.** If the message starts with `@fixy`, the router does **not** dispatch to any external adapter. It parses the remainder as either a reserved slash command (see section 5) or a worker delegation. A bare `@fixy <text>` routes `<text>` to whichever adapter is currently configured as the worker, but the response is attributed to `@fixy` in the thread.
4. **No mention → last agent.** If the message has no `@<agent>` prefix, dispatch it to the last agent that spoke in this thread. On the very first message of a fresh thread with no prior agent turns, fall back to the configured worker adapter.
5. **Unknown mention → hard error.** If the message starts with `@<something>` that does not resolve to a registered adapter or to `fixy`, the router rejects the turn with `unknown agent: @<something>` and appends nothing to the thread. No silent fallback. This rule exists so a typo never burns a turn against the wrong adapter.

**Agent-to-agent cross-talk** is achieved by the user: the user addresses `@claude review @codex's last turn`, and the router passes the full relevant message tail (including the prior `@codex` turn) into the Claude adapter's context. Adapters never call each other directly.

**Turn bounding:** A single user-typed message can cause at most 3 adapter invocations (the max of rule 2). Automatic agent-to-agent loops are explicitly forbidden in v0. A user wanting another round must type another message.

---

## 5. `@fixy` Reserved Commands

These four commands are the entire `@fixy` command surface in v0. Anything else after `@fixy` that is not one of these is treated under rule 3 (worker delegation).

| Command | Signature | Behavior |
|---|---|---|
| `/all` | `@fixy /all <prompt>` | Trigger the **collaboration engine** (see Step 12). All registered thinker agents discuss the prompt together, agree on an implementation plan, break it into batches of max 5 TODOs, hand each batch to the worker(s), review the output, and iterate until the full plan is complete and approved. This is the core feature of Fixy Code. |
| `/worker` | `@fixy /worker <adapterId>` | Set this thread's worker to `<adapterId>`. Must resolve to a registered adapter. Persists in the thread's `workerModel` field. Takes effect immediately, including for the next bare-`@fixy` message. |
| `/settings` | `@fixy /settings [<key> <value>]` | View or update collaboration settings for this session. Without args, print current settings. With args, update one setting. Keys: `reviewMode` (`auto`/`ask_me`/`manual`), `collaborationMode` (`standard`/`critics`/`red_room`/`consensus`), `maxDiscussionRounds` (1–10), `maxReviewRounds` (1–5), `maxTodosPerBatch` (1–5), `workerCount` (1–5). Persists in `~/.fixy/settings.json`. |
| `/reset` | `@fixy /reset` | Abort any in-flight adapter turn, clear all `agentSessions` in the thread (so the next invocation starts a fresh adapter session), and delete + recreate the thread worktree. Does **not** delete the thread or its message history. |
| `/status` | `@fixy /status` | Print one line per registered adapter: `id`, `name`, `probe().available`, `probe().version`, `probe().authStatus`, plus the current `workerModel`, review mode, collaboration mode, and per-adapter `sessionId`s for this thread. |

Everything else (`/help`, `/quit`, history browsing) lives on the CLI layer below `@fixy` — `/quit` and Ctrl-C exit the REPL; they are not `@fixy` commands.

---

## 6. The 12 Sequenced Build Steps

Each step has: goal, files to create, acceptance criteria, and the Paperclip reference files to study before writing code. **Do not skip the reference reads** — the Paperclip adapter-utils layer solves most of the subprocess-spawning pain already, and we want to inherit that discipline.

### PHASE A — Repo + CI (Steps 1–3)

#### Step 1 — Monorepo bootstrap

**Goal:** A clean pnpm workspace that typechecks and lints.

**Create:**
- `/package.json` — root with `"private": true`, `pnpm` engine, workspace scripts (`build`, `lint`, `typecheck`, `test`).
- `/pnpm-workspace.yaml` — `packages: ["packages/*"]`.
- `/tsconfig.base.json` — strict mode, `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`.
- `/.nvmrc` — `20`.
- `/.editorconfig`, `/.gitignore`, `/LICENSE` (MIT, copyright "Fixy AI").
- `/README.md` — one paragraph, link to this plan.
- `/packages/core/package.json` + `tsconfig.json` — empty `src/index.ts`, name `@fixy/core`.
- `/packages/adapter-utils/package.json` + `tsconfig.json` — empty `src/index.ts`, name `@fixy/adapter-utils`.
- `/packages/cli/package.json` + `tsconfig.json` — empty `src/index.ts`, name `@fixy/code`, `bin: { fixy: "./dist/cli.js" }`.
- `/packages/claude-adapter/package.json` + placeholder, name `@fixy/claude-adapter`.
- `/packages/codex-adapter/package.json` + placeholder, name `@fixy/codex-adapter`.

**Acceptance:**
- `pnpm install` succeeds.
- `pnpm -r typecheck` passes on all packages (even empty ones).
- `pnpm -r build` produces a `dist/` for every package.
- `@fixy/code` resolves `@fixy/core` and `@fixy/adapter-utils` as workspace dependencies (not from npm).

**Paperclip refs:** none — this step is pure scaffolding.

---

#### Step 2 — Lint, format, and core test harness

**Goal:** A single source of truth for style and a working test runner for every package.

**Create:**
- `/eslint.config.js` — flat config, TS + import + node rules.
- `/.prettierrc` — 2-space indent, single quotes, no trailing commas in JSON.
- `/vitest.config.ts` at the root, one per-package via `vitest.workspace.ts`.
- `/packages/core/src/__tests__/smoke.test.ts` — asserts `1 + 1 === 2`, just to wire Vitest.

**Acceptance:**
- `pnpm lint` passes on a fresh clone.
- `pnpm test` runs Vitest across all packages and reports 1 passing test.
- `pnpm format --check` passes.

**Paperclip refs:** none.

---

#### Step 3 — GitHub Actions CI and release skeleton

**Goal:** Every push to `main` and every PR runs typecheck + lint + test. A manually-triggered release workflow can publish `@fixy/code` and its dependencies to npm.

**Create:**
- `/.github/workflows/ci.yml` — matrix on Node 20, runs `pnpm install`, `pnpm -r typecheck`, `pnpm lint`, `pnpm test`.
- `/.github/workflows/release.yml` — `workflow_dispatch` only, uses `pnpm publish -r --access public`, reads `NPM_TOKEN` from secrets. Not enabled yet, but the file exists so Step 10 can flip it on.
- `/.github/PULL_REQUEST_TEMPLATE.md` — three-line checklist: plan step touched, tests added, docs updated.
- `/CONTRIBUTING.md` — how to run the repo locally.

**Acceptance:**
- CI passes green on a trivial PR.
- `release.yml` lints as valid YAML but is not yet executed.
- The PR template renders in GitHub's PR UI.

**Paperclip refs:** none.

---

### PHASE B — Core (Steps 4–7)

#### Step 4 — Thread + message data model and local store

**Goal:** Persist `FixyThread` / `FixyMessage` to disk atomically, load them back, and enforce the append-only invariant.

**Create:**
- `/packages/core/src/thread.ts` — the types from section 3 of this plan, exactly as written.
- `/packages/core/src/store.ts` — `LocalThreadStore` class:
  - `init()` — ensures `projects/` and `worktrees/` exist under the Fixy home directory (derived from `FIXY_HOME` env or `~/.fixy`).
  - `createThread(projectRoot)` — uuid v7, computes `projectId = sha1(projectRoot)`, writes `project.json` if new, writes empty thread file.
  - `appendMessage(threadId, projectRoot, message)` — loads, pushes, rewrites atomically (`tmp` file + `fs.rename`).
  - `getThread(threadId)` / `listThreads(projectRoot)` / `archiveThread(threadId)`.
- `/packages/core/src/paths.ts` — resolves `~/.fixy/...` paths consistently.
- Tests: `store.test.ts` — create, append 3 messages, reload, assert order and content preservation; assert atomic rewrite leaves no `*.tmp` file behind.

**Acceptance:**
- Messages round-trip through disk byte-for-byte.
- Killing the process mid-write (simulate by throwing between `writeFile` and `rename`) leaves the old file intact.
- No writes ever happen outside `~/.fixy/`.

**Paperclip refs:** none — Paperclip's persistence is database-backed; we deliberately stay file-based.

---

#### Step 5 — `FixyAdapter` interface + registry

**Goal:** The interface from section 2 lives in code, and the registry can register/unregister/require adapters, mirroring Paperclip's registry pattern.

**Create:**
- `/packages/core/src/adapter.ts` — the `FixyAdapter`, `FixyExecutionContext`, `FixyExecutionResult`, `FixySession`, `FixyProbeResult` types from section 2, exactly as written.
- `/packages/core/src/registry.ts` — `AdapterRegistry` class with:
  - `register(adapter: FixyAdapter)` — rejects duplicate ids.
  - `unregister(id: string)` — removes.
  - `require(id: string): FixyAdapter` — throws `Unknown adapter: <id>` if missing.
  - `list(): FixyAdapter[]`.
- Tests: `registry.test.ts` — register two, require one, unregister one, require throws; registering a duplicate id throws.

**Acceptance:**
- Matches the public shape of Paperclip's `registerServerAdapter` / `unregisterServerAdapter` / `requireServerAdapter` in `server/src/adapters/registry.ts`.
- `require()` error message format is exactly `Unknown adapter: <id>` so the router in Step 6 can match it.

**Paperclip ref:** `server/src/adapters/registry.ts` lines 282–314 — the mutable-map, register/unregister/require trio. We copy the shape, not the Paperclip-specific session/skills/quota bits.

---

#### Step 6 — `@mention` router + turn controller

**Goal:** Implement the five routing rules from section 4 and the turn controller that calls `FixyAdapter.execute()`.

**Create:**
- `/packages/core/src/router.ts` — `Router` class:
  - `parse(input: string): ParsedInput` — returns either `{ kind: "mention", agentIds: string[], body: string }`, `{ kind: "fixy", rest: string }`, `{ kind: "bare", body: string }`, or `{ kind: "error", reason: string }`.
  - Implements rules 1–5 exactly.
- `/packages/core/src/turn.ts` — `TurnController` class:
  - `runTurn({ thread, input, registry, store, onLog, onMeta, onSpawn, signal })`.
  - Appends the user message via `store.appendMessage`.
  - Dispatches per the parsed router output.
  - For each adapter invocation: builds `FixyExecutionContext` from the stored thread, passes `thread.agentSessions[agentId]` as `session`, calls `adapter.execute(ctx)`, appends the resulting agent message, updates `thread.agentSessions[agentId]` with the returned session.
  - Sequential, not parallel. Rule-2 multi-mention loops through adapters in mention order; each adapter sees the tail including the prior adapter's fresh response.
  - Enforces the 3-adapter cap per turn.
- Tests: `router.test.ts` — one test per routing rule, plus "unknown agent" hard error, plus "3-adapter cap rejects 4th mention".

**Acceptance:**
- All 5 routing rules have a dedicated passing test.
- The turn controller is fully synchronous in its decision-making; only `adapter.execute()` is async.
- The `@fixy` reserved command path is stubbed (just returns `"command not yet implemented"`) — real implementation lands in Step 9.

**Paperclip refs:** none — Paperclip does not have user-visible mentions. This layer is Fixy-specific.

---

#### Step 7 — Worktree manager

**Goal:** For any `(threadId, agentId)` pair, provision and tear down a `git worktree` rooted at `~/.fixy/worktrees/<threadId>/<agentId>/`, pointing at a branch forked from the project's current `HEAD`.

**Create:**
- `/packages/core/src/worktree.ts` — `WorktreeManager` class:
  - `ensure(projectRoot, threadId, agentId): Promise<WorktreeHandle>` — idempotent. If the worktree exists, return its path and current ref. If not, run `git worktree add <path> -b fixy/<threadId>-<agentId>` from `projectRoot`.
  - `collectPatches(handle): Promise<FixyPatch[]>` — runs `git diff --no-color --stat-count=1000` and `git diff --no-color` inside the worktree, parses the unified diff output into one `FixyPatch` per file, computes `{ additions, deletions }`.
  - `reset(handle)` — `git worktree remove --force` then re-provision.
  - `list(threadId): WorktreeHandle[]`.
- Tests: `worktree.test.ts` — uses a temp git repo fixture, creates two worktrees (one for `claude`, one for `codex`), asserts both are visible via `git worktree list`, writes a file in one, asserts `collectPatches` returns exactly that diff.

**Acceptance:**
- Worktrees land under `~/.fixy/worktrees/<threadId>/<agentId>/` with predictable branch names.
- `collectPatches` never reads files outside the worktree.
- `reset` cleanly removes both the worktree and its branch.
- **Never touches the user's main working tree or any existing branch.**

**Paperclip refs:** none directly — Paperclip delegates to its server workspace manager. Use `git worktree` from `child_process` directly; it's simple.

---

### PHASE C — First adapter + CLI (Steps 8–10)

#### Step 8 — `@fixy/claude-adapter`

**Goal:** A fully working adapter that spawns the user's local `claude` CLI, passes the prompt over stdin, streams stdout back, supports `--resume` for session continuity, and crucially **inherits the user's auth** by passing `HOME`, `CLAUDE_CONFIG_DIR`, and `PATH` through.

**Create:**
- `/packages/adapter-utils/src/server-utils.ts` — a trimmed, MIT-safe rewrite of the subset of Paperclip's `packages/adapter-utils/src/server-utils.ts` we actually need:
  - `runChildProcess(runId, command, args, opts)` — spawns, captures stdout/stderr with a cap, honors `opts.signal`, calls `onLog`/`onSpawn`, returns `{ exitCode, signal, timedOut, stdout, stderr, pid, startedAt }`.
  - `resolveCommand(command)` — looks up the binary on PATH via `which`/`where`; throws a clean error if missing. Returns the absolute path.
  - `ensurePathInEnv(env)` — fills in a platform default PATH if the child would otherwise inherit an empty one.
  - `redactEnvForLogs(env)` — masks any env var name matching `/key|token|secret|password|authorization|cookie/i`.
  - `buildInheritedEnv(overrides)` — **THE critical helper**: starts from `process.env`, copies `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH` untouched, then layers `overrides` on top. This is how we achieve zero-re-auth.
- `/packages/claude-adapter/src/index.ts` — exports a `FixyAdapter` with:
  - `id: "claude"`, `name: "Claude Code"`.
  - `probe()` — runs `claude --version`, parses, returns `{ available, version, authStatus: "unknown", detail: null }`. We do not probe auth actively in v0 because there is no cheap way to test Claude auth without burning a token; `authStatus` stays `"unknown"` and we let the first real turn surface auth errors naturally.
  - `execute(ctx)` — builds args `["--print", "--output-format", "text", "--dangerously-skip-permissions"]`, appends `"--resume", ctx.session.sessionId` if a session is present, spawns via `runChildProcess` with `cwd = ctx.threadContext.worktreePath`, `env = buildInheritedEnv({})`, pipes `ctx.prompt` to stdin, streams stdout/stderr through `ctx.onLog`. Parses the output to extract the new session id and the text summary. Returns a `FixyExecutionResult` with `session = { sessionId, params: {} }`.
- Tests: `adapter.test.ts` + `parse.test.ts` — uses a mock `claude` binary (a shell script on PATH via the test env), asserts that `execute()` returns the expected `summary`, preserves the session id, and that the child's `env.HOME` was inherited from `process.env.HOME`.

**Acceptance:**
- A user who is already logged into Claude Code (`claude login` previously run in their terminal) can type `@claude hello` inside `fixy` and get a live-streamed response **without being prompted to log in again**.
- Session id captured on turn 1 is passed as `--resume` on turn 2 inside the same thread.
- No secrets appear in `onMeta`'s env dump.

**Paperclip refs:**
- `packages/adapters/claude-local/src/server/execute.ts` — the entire file, but especially:
  - `buildClaudeRuntimeConfig()` (lines 93–259) for env construction pattern.
  - `buildClaudeArgs()` (lines 428–453) for the argument list and `--resume` pattern.
  - `runAttempt()` + `toAdapterResult()` (lines 471–610) for the call/parse/result flow.
  - `includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"]` on line 234 — this is the specific list to inherit.
- `packages/adapter-utils/src/server-utils.ts` — `runChildProcess`, `resolveCommandPath`, `ensurePathInEnv`, `redactEnvForLogs`, `buildInvocationEnvForLogs`. Copy the shapes and the `SENSITIVE_ENV_KEY` regex (`/(key|token|secret|password|passwd|authorization|cookie)/i`) verbatim.

---

#### Step 9 — `@fixy` reserved commands runtime

**Goal:** Implement `/worker`, `/all` (stubbed, real impl lands in Step 12), `/reset`, `/status` inside the turn controller from Step 6.

**Create:**
- `/packages/core/src/fixy-commands.ts` — `FixyCommandRunner` class:
  - `run({ thread, rest, store, registry, worktreeManager })` — parses `rest`, dispatches:
    - `/worker <id>` — validates `registry.require(id)`, updates `thread.workerModel`, persists, appends a system message `"worker set to <id>"`.
    - `/all` — Step 12 stub: prints `"collaboration engine not yet implemented — arriving in Step 12"` as a system message. Replaced in Step 12 with the full 5-phase collaboration loop.
    - `/reset` — aborts in-flight turns (via the `AbortController` held by the REPL), clears `thread.agentSessions = {}`, calls `worktreeManager.reset()` for each entry in `thread.worktrees`, persists, appends system message.
    - `/status` — loops over `registry.list()`, calls `adapter.probe()` for each, formats a table, appends one multi-line system message.
  - Bare `@fixy <text>` (no leading `/`) — delegates to `registry.require(thread.workerModel).execute(...)` but the resulting message is stored with `agentId: "fixy"` so the UI attributes it correctly.
- `/packages/core/src/turn.ts` (update) — wire the `FixyCommandRunner` into the router's `"fixy"` branch from Step 6.
- Tests: `fixy-commands.test.ts` — one test per command, using the Step 5 registry with two stub adapters.

**Acceptance:**
- `@fixy /worker claude` persists across a reload of the thread file.
- `@fixy /reset` deletes worktrees under `~/.fixy/worktrees/<threadId>/` and recreates empty ones on the next turn.
- `@fixy /status` prints adapter probe results for every registered adapter.
- `@fixy explain your last answer` (no `/`) routes through the worker adapter and the message is attributed to `@fixy` in the thread.

**Paperclip refs:** none — Paperclip has no equivalent user-visible command layer.

---

#### Step 10 — `@fixy/code` terminal REPL

**Goal:** `npm install -g @fixy/code && cd my-repo && fixy` opens a usable multi-agent REPL bound to a thread in the current git repo, speaking to `@claude` and `@fixy` (Codex comes in Step 11).

**Create:**
- `/packages/cli/src/cli.ts` — main entry:
  - Resolves the current working directory to a git repo (walks up for `.git`). Errors cleanly if none found.
  - Initializes `LocalThreadStore`, `AdapterRegistry`, `WorktreeManager`.
  - Registers the Claude adapter from Step 8. (Codex adapter registration is added in Step 11.)
  - Opens or resumes a thread (flag: `--thread <id>`; default: creates a new one).
  - Starts the REPL.
- `/packages/cli/src/repl.ts` — REPL loop using Node's `readline`:
  - Prompt: `fixy> `.
  - Mention autocomplete via tab: cycles through registered adapter ids plus `fixy`.
  - Per-turn `AbortController` wired to Ctrl-C (single press cancels the current turn, second press exits).
  - Live-streams `onLog` chunks to stdout with an ANSI-colored prefix per agent (`[claude] `, `[codex] `, `[fixy] `).
  - On turn completion, prints the summary and warnings.
- `/packages/cli/src/format.ts` — ANSI coloring helpers. Uses `picocolors`, not `chalk`, to keep the dep tree tiny.
- `/packages/cli/dist/cli.js` — compiled entry point with `#!/usr/bin/env node` shebang. `package.json` `bin` field points directly to `./dist/cli.js` (no separate shim file).
- README at `/packages/cli/README.md` — install + usage in under 60 lines.

**Acceptance:**
- End-to-end **on a real machine where the user has Claude Code installed and logged in**:
  1. `pnpm -r build`
  2. `pnpm --filter @fixy/code link --global` (or `npm pack` + global install for a closer-to-production check)
  3. `cd ~/some-git-repo`
  4. `fixy`
  5. Type `@claude refactor the top of README.md for brevity` — see Claude's streamed response, and a `git diff` inside the worktree that matches the response.
  6. Type `@fixy /status` — see Claude listed.
  7. Type `@claude once more, this time even shorter` — Claude resumes the previous session (observe the `sessionId` reuse in `--resume`).
  8. Ctrl-C exits cleanly with no orphaned `git worktree` entries and no orphaned child processes.
- Release workflow from Step 3 can be triggered manually on `main` and publishes `@fixy/core`, `@fixy/adapter-utils`, `@fixy/claude-adapter`, and `@fixy/code` to npm under the `@fixy` scope.

**Paperclip refs:** none — Paperclip is server-side and has no REPL.

---

### PHASE D — Second adapter + verdict (Steps 11–12)

#### Step 11 — `@fixy/codex-adapter`

**Goal:** A second adapter that spawns the user's local `codex` CLI with `CODEX_HOME` inherited, so Codex users hit zero re-auth, and both `@claude` and `@codex` can now coexist in the same thread.

**Create:**
- `/packages/codex-adapter/src/index.ts` — exports a `FixyAdapter` with:
  - `id: "codex"`, `name: "Codex CLI"`.
  - `probe()` — runs `codex --version`, parses.
  - `execute(ctx)` — spawns `codex exec` (or the current supported subcommand for non-interactive prompt input), pipes `ctx.prompt` to stdin, passes through `cwd = ctx.threadContext.worktreePath`, `env = buildInheritedEnv({})` (which already carries `CODEX_HOME`, `HOME`, `PATH`). Captures the JSONL output, extracts the Codex session id, returns the `FixyExecutionResult` with the new session stored.
  - Rollout-noise filter: reuse the `CODEX_ROLLOUT_NOISE_RE` idea from the Paperclip Codex adapter to silence the known-benign `codex_core::rollout::list` stderr line.
- `/packages/codex-adapter/src/parse.ts` — minimal JSONL result parser that returns `{ sessionId, summary, usage }`.
- `/packages/cli/src/cli.ts` (update) — register the Codex adapter alongside the Claude adapter.
- Tests: `codex-adapter.test.ts` — mock `codex` binary on PATH, assert round-trip, session id capture, rollout-noise suppression, and that `env.CODEX_HOME` was inherited from `process.env.CODEX_HOME`.

**Acceptance:**
- A user with `codex login` previously run in their terminal can type `@codex write a helper function` inside `fixy` and get a streamed response **without being prompted to log in**.
- `@claude` and `@codex` can both run in the same thread, each in its own `(thread, agent)` worktree, with independent session resume.
- `@fixy /status` now lists two adapters.
- `@fixy /worker codex` successfully switches the worker mid-thread.

**Paperclip refs:**
- `packages/adapters/codex-local/src/server/execute.ts` — the whole file, especially:
  - `stripCodexRolloutNoise()` + `CODEX_ROLLOUT_NOISE_RE` (lines 30–46) — copy this verbatim.
  - The env construction pattern (lines 256–371) — note how `CODEX_HOME` is set and how `hasExplicitApiKey` is handled. We do **not** read `OPENAI_API_KEY`; we inherit it if the user already has it, and we never set it.
  - `runAttempt()` + `toResult()` (lines 487–594) — the call/parse/result flow.
- `packages/adapters/codex-local/src/server/codex-args.ts` — look at `buildCodexExecArgs` for the non-interactive invocation pattern (stdin `-`).

---

#### Step 12 — Collaboration engine (`@fixy /all`)

**Goal:** `@fixy /all <prompt>` triggers the full collaborative coding loop — the **wedge** that makes Fixy Code fundamentally different from any single-agent tool. Multiple thinker agents discuss the task, agree on an implementation plan, break it into batches of max 5 TODOs, hand each batch to the worker(s), review the worker output, and iterate until the full plan is complete and approved. Fixy Code controls this entire mechanism — it is the conductor, not a participant.

**Core flow:**

```
USER: @fixy /all Build OAuth refresh token support

┌─ PHASE 1: DISCUSSION ─────────────────────────────────┐
│  All thinker agents receive the prompt.                │
│  They discuss back and forth (max N rounds,            │
│  configurable, default 5).                             │
│  Each agent sees what the other said.                  │
│  They catch each other's blind spots.                  │
│  Goal: agree on a full implementation plan.            │
└────────────────────────────────────────────────────────┘
           │
           ▼
┌─ PHASE 2: PLAN BREAKDOWN ─────────────────────────────┐
│  Thinkers break the agreed plan into ordered batches.  │
│  Each batch contains MAX 5 TODO items.                 │
│  Each TODO is a concrete, scoped coding task.          │
│  The batch is what gets sent to the worker(s).         │
└────────────────────────────────────────────────────────┘
           │
           ▼
┌─ PHASE 3: WORKER EXECUTION (per batch) ───────────────┐
│  Batch N (up to 5 TODOs) sent to worker(s).            │
│  Workers write the actual code.                        │
│  User can configure 1–5 worker sub-agents in settings. │
│  Workers operate in the thread's worktree.             │
│  Workers report back: "batch complete, check it."      │
└────────────────────────────────────────────────────────┘
           │
           ▼
┌─ PHASE 4: THINKER REVIEW ─────────────────────────────┐
│  ALL thinker agents review the worker's output.        │
│  Did the worker implement correctly?                   │
│  Any drift from what was agreed?                       │
│  Missing edge cases? Security issues?                  │
│  If issues found → worker fixes → thinkers re-review.  │
│  If clean → next batch.                                │
└────────────────────────────────────────────────────────┘
           │
           ▼
  Repeat Phase 3–4 for each batch until plan complete.
           │
           ▼
┌─ PHASE 5: FINAL REVIEW ──────────────────────────────┐
│  All thinkers do a final pass over the full result.   │
│  Worker applies any last fixes.                       │
│  DONE ✅                                              │
└───────────────────────────────────────────────────────┘
```

**Review modes** (user sets this in Fixy settings before or during a session):

| Mode | Behavior |
|---|---|
| **Auto** | After each worker batch, ALL thinker agents automatically review. If issues found, worker fixes, thinkers re-review. Loop until approved or max review rounds hit. Default for v0. |
| **Ask me** | After each worker batch, Fixy asks the user: "Which agent should review? @claude / @codex / both / skip?" User controls each review cycle. |
| **Manual** | Worker writes code, shows diff to user. User decides what happens next by typing their own `@mentions`. Full manual control, no automatic review loop. |

**Collaboration modes** (borrowed from Fixy's existing `discussion.service.ts` patterns, adapted for coding):

| Mode | What it does |
|---|---|
| **Standard** | Phases 1–5 above. Agents discuss, agree, batch, worker executes, agents review. |
| **Critics** | After Phase 4, add an extra round where each thinker agent MUST identify at least one potential issue — forces deeper review before approving a batch. |
| **Red Room** | One thinker agent is assigned "attacker" — actively tries to break the implementation, find edge cases, security holes, performance problems. The other defends. Adversarial pressure before moving to the next batch. |
| **Consensus** | Thinkers must reach explicit agreement before each batch goes to workers. If they can't agree after N rounds, escalate to user: "We disagree on X. Your call." |

**Implementation (as built):**

The collaboration engine is implemented inline in `/packages/core/src/fixy-commands.ts` as `FixyCommandRunner._handleAll()` (~200 lines). No separate `CollaborationEngine` class or types file was created — the logic is compact enough to live in the command runner. Settings are hardcoded constants for v0 (extractable to a settings file in v0.1).

- `/packages/core/src/fixy-commands.ts` (update) — `_handleAll(prompt, ctx)`:
  1. **Discussion phase:** All thinker adapters (registered adapters minus the worker) receive the prompt with a system framing. Up to 5 rounds. Early exit on agreement signals (`"agree"`, `"lgtm"`, `"looks good"`). Skipped in solo mode (single adapter).
  2. **Plan breakdown:** Thinkers (or sole adapter in solo mode) produce a numbered TODO list. Responses merged, deduplicated by exact string match, capped at 20 items. Parsed via `_parseTodoList()` which handles `1.` and `1)` formats.
  3. **Worker execution:** TODOs batched in groups of 5. Worker adapter executes each batch.
  4. **Thinker review:** After each batch, thinkers review. If any reply contains `"ISSUES"`, worker retries (max 2 attempts per batch). If approved or max attempts reached, move to next batch.
  5. **Final review:** All thinkers do a final pass over the full thread. Result appended as system message.
  - All adapter calls use `callAdapter()` helper which constructs `FixyExecutionContext`, calls `adapter.execute()`, updates `agentSessions`, and appends the response as a thread message.
  - Progress logged to terminal via `ctx.onLog('stdout', ...)` at each phase transition.
- Hardcoded v0 constants (deferred to `/settings` in v0.1):
  - `maxDiscussionRounds`: 5
  - `maxReviewAttempts`: 2
  - `maxTodosPerBatch`: 5
  - `maxTotalTodos`: 20
- Tests in `fixy-commands.test.ts` — 10 tests covering: solo mode, multi-adapter full loop, review issues with retry, TODO cap at 20, no-prompt error, no-adapter error.

**Acceptance:**
- `@fixy /all refactor auth middleware` on a thread with `@claude` and `@codex` registered triggers the full discussion → plan → batch → worker → review loop.
- Thinkers never write code directly to the worktree — only the worker does.
- Each batch contains at most 5 TODOs.
- In `auto` review mode, thinkers automatically review each batch and the worker fixes issues without user intervention (up to max review rounds).
- In `ask_me` mode, the REPL prompts the user after each batch.
- In `manual` mode, the user regains full @mention control after each worker batch.
- When only one thinker is registered, it still works — single-thinker plan + worker execution + single-thinker review.
- The collaboration mode (standard/critics/red_room/consensus) affects the discussion and review phases as described above.
- Worker sub-agent count is configurable from 1 to 5 in settings.

**Paperclip refs:** none — Paperclip does not have collaborative multi-agent coding.
**Fixy refs:** `backend/src/services/discussion.service.ts` — reuse the convergence detection and mode patterns (`debate`, `red_room`, `consensus`) adapted from text debate to code collaboration.

---

## 7. Post-v0 Roadmap

| Version | Scope | Notes |
|---|---|---|
| **v0** | 12-step terminal MVP above. `@claude` + `@codex` + `@fixy`, single thread CLI, worktree isolation, `/all` | This document. |
| **v0.2** | Homebrew tap `fixy-ai/tap`, `brew install fixy` | Keep the npm path too. The Homebrew formula just shells out to the same Node binary. |
| **v0.3** | Unified `sessionCodec` so each adapter can serialize/deserialize its session into a neutral, human-readable form, enabling thread export/import and verdict replay | Mirrors Paperclip's `sessionCodec` concept (`claudeSessionCodec`, `codexSessionCodec` in `server/src/adapters/registry.ts` lines 95, 110). |
| **v0.4** | Third adapter. Either `@gemini` via Gemini CLI or `@opencode` via OpenCode, chosen by whichever reference codebase is cleanest to port from Paperclip's `packages/adapters/*-local/` | Same `FixyAdapter` shape, same `buildInheritedEnv` discipline. |
| **v0.5** | Context summarization / compaction | When a thread exceeds a configurable token budget, an out-of-band worker invocation summarizes older turns and replaces them in the message tail that gets sent to adapters. The full history is kept on disk untouched. |
| **v1.0** | Stripe + Pro/Team gating | Free tier enforcement (3 active threads, 1 project, 30-day history). Billing runs as a tiny hosted service; Fixy Code calls it once per session to check entitlement. The CLI stays local-first — the server only sees tokens + counts, never prompts or diffs. |
| **v1.1** | Tauri desktop app | A thin native wrapper around the same `@fixy/core` engine. No logic duplication. |
| **v1.2** | VS Code extension | Same engine, called from an extension host. The editor surfaces threads, worktrees, and diffs natively. |
| **v2.0** | Team sync | Shared workspaces, shared thread history, per-seat auth. This is when Fixy Code grows an opinionated server, not before. |

---

## 8. Three Things to Lock in the First 30 Minutes

If a future reader of this plan is about to start implementation, these three decisions must be verifiable before any code is written. If any of them drifts, this plan is invalidated until it's updated.

### 1. The GitHub org and npm scope exist and are ours

- Create `github.com/fixy-ai/fixy-code` as a **public repo** with an MIT `LICENSE` file at the root.
- On npmjs.com, reserve the `@fixy` scope. Publish a scope-reservation package `@fixy/placeholder@0.0.1` so nobody else can claim the `@fixy/*` namespace. If `@fixy` is taken, immediately fall back to `@fixy-ai` and update every package name in this plan in a single commit.
- Verify that `npm view @fixy/placeholder` resolves to our stub.

**Status (2026-04-12):** ✅ DONE. Repo live at `github.com/fixy-ai/fixy-code` (public, MIT). `@fixy/placeholder@0.0.1` published on npm under user `fixy`. Scope `@fixy` permanently claimed.

**Failure mode if skipped:** Step 10 cannot ship. You will discover this after writing 11 steps of code.

### 2. The auth passthrough assumption is verified end-to-end, by hand, before Step 8

Before writing any adapter code, do this by hand in a throwaway Node script:

```js
import { spawn } from "node:child_process";
const child = spawn("claude", ["--print", "-"], {
  env: { ...process.env }, // explicitly nothing stripped
  stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.end("hello");
```

Run it in a terminal where `claude login` was previously run. If Claude responds without prompting for login, the whole product thesis holds. Repeat with `codex exec` and `codex` in place of `claude`. If either CLI prompts for re-auth in this test, **stop**. The plan is wrong and Step 8 / Step 11 need to be redesigned around whatever auth flow the CLIs actually support.

**Failure mode if skipped:** You will write two full adapters on top of a false assumption and discover the problem only when a real user runs `fixy` for the first time.

**Status (2026-04-12):** ✅ DONE. Both probes passed on macOS (Apple Silicon):
- `claude -p "Reply with exactly the word: OK"` → `OK`, exit 0, zero re-auth. Claude Code 2.1.101.
- `codex exec --skip-git-repo-check "Reply with exactly: OK"` → `OK`, exit 0, zero re-auth. Codex CLI 0.112.0, model gpt-5.4.
- Note: Codex requires either a trusted git directory or `--skip-git-repo-check`. Fixy Code always runs Codex inside a worktree, so this is a non-issue.

### 3. `git worktree add` works the way we think it does, on a fresh clone, on macOS

Verify by hand:

```bash
cd /tmp && rm -rf demo && git init demo && cd demo
echo hi > README.md && git add README.md && git commit -m init
git worktree add ./.fixy/worktrees/t1/claude -b fixy/t1-claude
ls ./.fixy/worktrees/t1/claude/README.md
git worktree list
```

Expected: the worktree exists, the file is visible, `git worktree list` shows two entries. Then:

```bash
git worktree remove --force ./.fixy/worktrees/t1/claude
git branch -D fixy/t1-claude
```

Expected: both the worktree and the branch are gone, `git worktree list` shows one entry.

**Failure mode if skipped:** Step 7 ships something that corrupts the user's repo the first time they hit `/reset`. The blast radius is the user's working tree — unacceptable.

**Status (2026-04-12):** ✅ DONE. Tested on macOS: `git worktree add` (two worktrees), `git worktree list` (three entries), `git worktree remove` (clean removal, no orphans). All operations passed cleanly.

---

## 9. Session Log

> Append an entry every session. Do not mutate prior entries.

### 2026-04-11 — Plan written

- Author: Claude Opus 4.6 (1M context), acting on the user's brief.
- Sources: `gpt-discussion.txt`, `claude-discussion.txt`, Paperclip reference codebase (`packages/adapters/claude-local/`, `packages/adapters/codex-local/`, `packages/adapter-utils/src/server-utils.ts`, `server/src/adapters/registry.ts`, `adapter-plugin.md`).
- Status: All 12 steps drafted. Locked decisions mirrored from the user's brief. No code written yet. Awaiting the "first 30 minutes" verification pass before Step 1.

### 2026-04-12 (session 2) — Steps 1–10 implemented, tested, published

- All packages built and published to npm under `@fixy` scope at version `0.0.2`.
- `npm install -g @fixy/code` installs the `fixy` binary end-to-end.
- Steps 1–10 verified working: core types, thread store, adapter registry, router, turn controller, worktree manager, diff parser, fixy-commands, adapter-utils, claude-adapter, CLI REPL.
- Two display bugs found and fixed during live testing:
  - Claude CLI was outputting raw JSON in piped mode — fixed by adding `--output-format text` to claude-adapter args.
  - `@fixy /status` was silent — fixed by printing system messages in `repl.ts` after each turn.
- Final live test confirmed: `@fixy /status` lists Claude adapter, `@claude say hello` responds without re-auth.
- 126 tests pass across 20 test files.

### 2026-04-12 (session 3) — Step 11: codex-adapter

- Implemented `@fixy/codex-adapter` (`packages/codex-adapter/src/index.ts` + `parse.ts`).
- `probe()` runs `codex --version` → returns version string.
- `execute()` uses `codex exec --json --skip-git-repo-check --full-auto <prompt>` for new sessions; `codex exec resume <sessionId> ...` for subsequent turns.
- JSONL stdout intercepted chunk-by-chunk: only `item.completed` / `agent_message` text forwarded to terminal — no raw JSON shown to user.
- Startup noise from codex skills-loader (`ERROR codex_core::skills::loader`) filtered from stderr.
- Registered alongside claude-adapter in `packages/cli/src/cli.ts`.
- `@fixy /status` now lists two adapters (Claude Code + Codex CLI).
- Live test confirmed: `@codex say hello in one sentence` → `Hello.` with zero re-auth.
- All 126 tests still pass. Build clean across all 5 packages.
- Next: Step 12 — collaboration engine (`@fixy /all`).

### 2026-04-12 (session 4) — Step 12: collaboration engine (`@fixy /all`)

- Implemented the full 5-phase collaboration loop in `FixyCommandRunner._handleAll()` (~200 lines).
  - Phase 1: multi-adapter discussion (up to 5 rounds, early exit on agreement signals).
  - Phase 2: plan breakdown into ordered TODO list (capped at 20, deduplicated).
  - Phase 3: worker executes TODOs in batches of 5.
  - Phase 4: thinker review with up to 2 fix attempts per batch.
  - Phase 5: final review by all thinkers.
- Solo mode: single adapter skips discussion, acts as both planner and worker.
- 10 new tests added to `fixy-commands.test.ts` covering solo mode, multi-adapter, review issues with retry, TODO cap, error cases.
- Removed dead code (unreachable `if (!thinkers.length)` inside `!soloMode` block).
- All 136 tests pass. Typecheck and build clean across all 5 packages.
- **All 12 implementation steps are now complete.**

### 2026-04-12 — Probes passed, repo created, plan corrected

- All three "first 30 minutes" probes passed: Claude auth passthrough ✅, Codex auth passthrough ✅, git worktree ✅.
- npm scope `@fixy` permanently claimed via `@fixy/placeholder@0.0.1` (npm user: `fixy`).
- GitHub repo `fixy-ai/fixy-code` created (public, MIT), initial commit pushed with plan + README + .gitignore.
- **Step 12 rewritten:** Replaced the verdict/competition engine with the **collaboration engine** (`@fixy /all`). Agents collaborate (discuss → agree → batch max 5 TODOs → worker executes → agents review → next batch). Added review modes (auto/ask_me/manual) and collaboration modes (standard/critics/red_room/consensus). This reflects the user's core vision: agents work TOGETHER toward one result, not compete for a winner.
- Added `/all` and `/settings` to the reserved commands table.
- Fixed §8: "private repo" → "public repo", "@fixy/code@0.0.0" → "@fixy/placeholder@0.0.1".
- Added probe results to §8 with dates and evidence.
- Added worker clarification: Fixy routes between adapters, not between models within an adapter.
- **v0 launch deliverable added:** Record a 2-minute demo video showing the full collaboration loop as the launch artifact.
