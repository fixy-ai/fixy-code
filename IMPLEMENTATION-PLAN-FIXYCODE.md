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
| v0 distribution | `npm install -g @fixy/cli` |
| v0 surface | Terminal-only |
| v0 platform | macOS first (Linux should work; Windows explicitly out of scope) |
| v0 adapters | `@claude` (Claude Code), `@codex` (Codex CLI) |
| Auth model | **Inherited env only.** Spawn subprocesses with `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH`. No re-auth. No credential storage inside Fixy Code. |
| Routing handles | `@claude`, `@codex`, `@fixy` (reserved) |
| Worker model | User-selected via `@fixy /worker-model <adapter>`. Fixy Code never ships its own models. |
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
| Install | `npm install -g @fixy/cli` → `fixy` on PATH |
| CLI | `fixy` opens a REPL bound to a thread inside the current repo |
| Adapters | `@claude` via `claude` binary, `@codex` via `codex` binary (both required on PATH) |
| Auth | Zero. Inherited `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH` passed through to child processes. |
| Routing | `@claude`, `@codex`, `@fixy` mention dispatch inside one shared thread |
| Worker model | `@fixy` answers via whichever adapter the user has set as the worker model |
| Commands | `/worker-model`, `/verdict`, `/reset`, `/status` |
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
  id: string;                         // uuid v7
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
  id: string;                         // uuid v7, monotonic by createdAt
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
├── config.json                       # global config, fixy version, default worker model
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
3. **`@fixy` reserved.** If the message starts with `@fixy`, the router does **not** dispatch to any external adapter. It parses the remainder as either a reserved slash command (see section 5) or a worker-model delegation. A bare `@fixy <text>` routes `<text>` to whichever adapter is currently configured as the worker model, but the response is attributed to `@fixy` in the thread.
4. **No mention → last agent.** If the message has no `@<agent>` prefix, dispatch it to the last agent that spoke in this thread. On the very first message of a fresh thread with no prior agent turns, fall back to the configured worker model adapter.
5. **Unknown mention → hard error.** If the message starts with `@<something>` that does not resolve to a registered adapter or to `fixy`, the router rejects the turn with `unknown agent: @<something>` and appends nothing to the thread. No silent fallback. This rule exists so a typo never burns a turn against the wrong adapter.

**Agent-to-agent cross-talk** is achieved by the user: the user addresses `@claude review @codex's last turn`, and the router passes the full relevant message tail (including the prior `@codex` turn) into the Claude adapter's context. Adapters never call each other directly.

**Turn bounding:** A single user-typed message can cause at most 3 adapter invocations (the max of rule 2). Automatic agent-to-agent loops are explicitly forbidden in v0. A user wanting another round must type another message.

---

## 5. `@fixy` Reserved Commands

These four commands are the entire `@fixy` command surface in v0. Anything else after `@fixy` that is not one of these is treated under rule 3 (worker-model delegation).

| Command | Signature | Behavior |
|---|---|---|
| `/worker-model` | `@fixy /worker-model <adapterId>` | Set this thread's worker model to `<adapterId>`. Must resolve to a registered adapter. Persists in the thread's `workerModel` field. Takes effect immediately, including for the next bare-`@fixy` message. |
| `/verdict` | `@fixy /verdict` | Run the verdict engine (see Step 12). Walks the last turn from each adapter that spoke in this thread, collects patches from each adapter's worktree via `git diff`, and prints a side-by-side summary ranked by a simple heuristic: (1) patches that apply cleanly to projectRoot, (2) smaller diff, (3) fewer warnings. **Never auto-applies.** |
| `/reset` | `@fixy /reset` | Abort any in-flight adapter turn, clear all `agentSessions` in the thread (so the next invocation starts a fresh adapter session), and delete + recreate all `(thread, agent)` worktrees. Does **not** delete the thread or its message history. |
| `/status` | `@fixy /status` | Print one line per registered adapter: `id`, `name`, `probe().available`, `probe().version`, `probe().authStatus`, plus the current `workerModel` and per-adapter `sessionId`s for this thread. |

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
- `/packages/cli/package.json` + `tsconfig.json` — empty `src/index.ts`, name `@fixy/cli`, `bin: { fixy: "./dist/cli.js" }`.
- `/packages/claude-adapter/package.json` + placeholder, name `@fixy/claude-adapter`.
- `/packages/codex-adapter/package.json` + placeholder, name `@fixy/codex-adapter`.

**Acceptance:**
- `pnpm install` succeeds.
- `pnpm -r typecheck` passes on all packages (even empty ones).
- `pnpm -r build` produces a `dist/` for every package.
- `@fixy/cli` resolves `@fixy/core` and `@fixy/adapter-utils` as workspace dependencies (not from npm).

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

**Goal:** Every push to `main` and every PR runs typecheck + lint + test. A manually-triggered release workflow can publish `@fixy/cli` and its dependencies to npm.

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
  - `init(home = ~/.fixy)` — ensures `projects/` and `worktrees/` exist.
  - `createThread(projectRoot)` — uuid v7, computes `projectId = sha1(projectRoot)`, writes `project.json` if new, writes empty thread file.
  - `appendMessage(threadId, message)` — loads, pushes, rewrites atomically (`tmp` file + `fs.rename`).
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
  - `parse(input: string): ParsedInput` — returns either `{ kind: "mentions", agentIds: string[], body: string }`, `{ kind: "fixy", rest: string }`, `{ kind: "bare", body: string }`, or `{ kind: "error", reason: string }`.
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
  - `ensureCommandResolvable(command, cwd, env)` — looks up the binary on PATH; throws a clean error if missing.
  - `resolveCommandForLogs(command, cwd, env)` — returns the absolute path for the transcript.
  - `ensurePathInEnv(env)` — fills in a platform default PATH if the child would otherwise inherit an empty one.
  - `redactEnvForLogs(env)` — masks any env var name matching `/key|token|secret|password|authorization|cookie/i`.
  - `buildInheritedEnv(overrides)` — **THE critical helper**: starts from `process.env`, copies `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH` untouched, then layers `overrides` on top. This is how we achieve zero-re-auth.
- `/packages/claude-adapter/src/index.ts` — exports a `FixyAdapter` with:
  - `id: "claude"`, `name: "Claude Code"`.
  - `probe()` — runs `claude --version`, parses, returns `{ available, version, authStatus: "unknown", detail: null }`. We do not probe auth actively in v0 because there is no cheap way to test Claude auth without burning a token; `authStatus` stays `"unknown"` and we let the first real turn surface auth errors naturally.
  - `execute(ctx)` — builds args `["--print", "-", "--output-format", "stream-json", "--verbose"]`, appends `"--resume", ctx.session.sessionId` if a session is present, spawns via `runChildProcess` with `cwd = ctx.threadContext.worktreePath`, `env = buildInheritedEnv({})`, pipes `ctx.prompt` to stdin, streams stdout/stderr through `ctx.onLog`. Parses the final stream-json result to extract the new session id and the text summary. Returns a `FixyExecutionResult` with `session = { sessionId, params: {} }`.
- Tests: `claude-adapter.test.ts` — uses a mock `claude` binary (a shell script on PATH via the test env) that prints a fixed stream-json payload, asserts that `execute()` returns the expected `summary`, preserves the session id, and that the child's `env.HOME` was inherited from `process.env.HOME`.

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

**Goal:** Implement `/worker-model`, `/verdict` (stubbed, real impl lands in Step 12), `/reset`, `/status` inside the turn controller from Step 6.

**Create:**
- `/packages/core/src/fixy-commands.ts` — `FixyCommandRunner` class:
  - `run({ thread, rest, store, registry, worktreeManager })` — parses `rest`, dispatches:
    - `/worker-model <id>` — validates `registry.require(id)`, updates `thread.workerModel`, persists, appends a system message `"worker model set to <id>"`.
    - `/verdict` — Step 12 stub: prints `"verdict engine arrives in step 12"` as a system message. Will be replaced in Step 12.
    - `/reset` — aborts in-flight turns (via the `AbortController` held by the REPL), clears `thread.agentSessions = {}`, calls `worktreeManager.reset()` for each entry in `thread.worktrees`, persists, appends system message.
    - `/status` — loops over `registry.list()`, calls `adapter.probe()` for each, formats a table, appends one multi-line system message.
  - Bare `@fixy <text>` (no leading `/`) — delegates to `registry.require(thread.workerModel).execute(...)` but the resulting message is stored with `agentId: "fixy"` so the UI attributes it correctly.
- `/packages/core/src/turn.ts` (update) — wire the `FixyCommandRunner` into the router's `"fixy"` branch from Step 6.
- Tests: `fixy-commands.test.ts` — one test per command, using the Step 5 registry with two stub adapters.

**Acceptance:**
- `@fixy /worker-model claude` persists across a reload of the thread file.
- `@fixy /reset` deletes worktrees under `~/.fixy/worktrees/<threadId>/` and recreates empty ones on the next turn.
- `@fixy /status` prints adapter probe results for every registered adapter.
- `@fixy explain your last answer` (no `/`) routes through the worker model adapter and the message is attributed to `@fixy` in the thread.

**Paperclip refs:** none — Paperclip has no equivalent user-visible command layer.

---

#### Step 10 — `@fixy/cli` terminal REPL

**Goal:** `npm install -g @fixy/cli && cd my-repo && fixy` opens a usable multi-agent REPL bound to a thread in the current git repo, speaking to `@claude` and `@fixy` (Codex comes in Step 11).

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
- `/packages/cli/bin/fixy.js` — `#!/usr/bin/env node` shim that imports `dist/cli.js`.
- README at `/packages/cli/README.md` — install + usage in under 60 lines.

**Acceptance:**
- End-to-end **on a real machine where the user has Claude Code installed and logged in**:
  1. `pnpm -r build`
  2. `pnpm --filter @fixy/cli link --global` (or `npm pack` + global install for a closer-to-production check)
  3. `cd ~/some-git-repo`
  4. `fixy`
  5. Type `@claude refactor the top of README.md for brevity` — see Claude's streamed response, and a `git diff` inside the worktree that matches the response.
  6. Type `@fixy /status` — see Claude listed.
  7. Type `@claude once more, this time even shorter` — Claude resumes the previous session (observe the `sessionId` reuse in `--resume`).
  8. Ctrl-C exits cleanly with no orphaned `git worktree` entries and no orphaned child processes.
- Release workflow from Step 3 can be triggered manually on `main` and publishes `@fixy/core`, `@fixy/adapter-utils`, `@fixy/claude-adapter`, and `@fixy/cli` to npm under the `@fixy` scope.

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
- `@fixy /worker-model codex` successfully switches the worker model mid-thread.

**Paperclip refs:**
- `packages/adapters/codex-local/src/server/execute.ts` — the whole file, especially:
  - `stripCodexRolloutNoise()` + `CODEX_ROLLOUT_NOISE_RE` (lines 30–46) — copy this verbatim.
  - The env construction pattern (lines 256–371) — note how `CODEX_HOME` is set and how `hasExplicitApiKey` is handled. We do **not** read `OPENAI_API_KEY`; we inherit it if the user already has it, and we never set it.
  - `runAttempt()` + `toResult()` (lines 487–594) — the call/parse/result flow.
- `packages/adapters/codex-local/src/server/codex-args.ts` — look at `buildCodexExecArgs` for the non-interactive invocation pattern (stdin `-`).

---

#### Step 12 — Verdict engine

**Goal:** `@fixy /verdict` produces a real, actionable side-by-side comparison of the last turn from each adapter that has spoken in the current thread, ranking them by a simple deterministic heuristic. This is the **wedge**: it's the one thing Fixy Code does that neither Claude Code nor Codex alone can do.

**Create:**
- `/packages/core/src/verdict.ts` — `VerdictEngine` class:
  - `run({ thread, store, worktreeManager }): Promise<VerdictResult>`:
    1. For each `agentId` in `thread.worktrees`, find the most recent message in `thread.messages` where `agentId === <that id>`.
    2. Call `worktreeManager.collectPatches(handle)` for each agent's worktree to get the current patch set.
    3. For each patch set, run `git apply --check --3way <diff>` against a throwaway clone of `projectRoot` at `HEAD` to test whether it applies cleanly.
    4. Score each candidate: `applies_cleanly` (bool, heaviest weight) → `total_line_delta` (ascending) → `warning_count` (ascending). Lower is better.
    5. Render a plain-text side-by-side table: columns `agent | files | +/- | applies? | warnings`. Print the winner's summary in full, the runner-up's summary truncated to 10 lines.
  - Returns a `VerdictResult` object; the command runner appends it as a system message.
- `/packages/core/src/fixy-commands.ts` (update) — replace the Step 9 `/verdict` stub with a real call to `VerdictEngine.run()`.
- Tests: `verdict.test.ts` — two stub adapters each produce a diff against a fixture repo, one applies cleanly and one conflicts, assert the clean one wins, assert the losing diff is still printed as the runner-up.

**Acceptance:**
- `@fixy /verdict` on a thread where both `@claude` and `@codex` have each produced a patch prints a deterministic table and picks a winner.
- **Never auto-applies.** The verdict is informational. The user then types `@claude` or `@codex` or applies the diff by hand from the worktree path printed in the table.
- When only one agent has spoken, the verdict just reports that agent's patch with no comparison.
- When no agent has spoken, the verdict prints `"no agent turns to compare"`.

**Paperclip refs:** none — Paperclip does not have a verdict concept; this is Fixy-original.

---

## 7. Post-v0 Roadmap

| Version | Scope | Notes |
|---|---|---|
| **v0** | 12-step terminal MVP above. `@claude` + `@codex` + `@fixy`, single thread CLI, worktree isolation, `/verdict` | This document. |
| **v0.2** | Homebrew tap `fixy-ai/tap`, `brew install fixy` | Keep the npm path too. The Homebrew formula just shells out to the same Node binary. |
| **v0.3** | Unified `sessionCodec` so each adapter can serialize/deserialize its session into a neutral, human-readable form, enabling thread export/import and verdict replay | Mirrors Paperclip's `sessionCodec` concept (`claudeSessionCodec`, `codexSessionCodec` in `server/src/adapters/registry.ts` lines 95, 110). |
| **v0.4** | Third adapter. Either `@gemini` via Gemini CLI or `@opencode` via OpenCode, chosen by whichever reference codebase is cleanest to port from Paperclip's `packages/adapters/*-local/` | Same `FixyAdapter` shape, same `buildInheritedEnv` discipline. |
| **v0.5** | Context summarization / compaction | When a thread exceeds a configurable token budget, an out-of-band worker-model invocation summarizes older turns and replaces them in the message tail that gets sent to adapters. The full history is kept on disk untouched. |
| **v1.0** | Stripe + Pro/Team gating | Free tier enforcement (3 active threads, 1 project, 30-day history). Billing runs as a tiny hosted service; Fixy Code calls it once per session to check entitlement. The CLI stays local-first — the server only sees tokens + counts, never prompts or diffs. |
| **v1.1** | Tauri desktop app | A thin native wrapper around the same `@fixy/core` engine. No logic duplication. |
| **v1.2** | VS Code extension | Same engine, called from an extension host. The editor surfaces threads, worktrees, and diffs natively. |
| **v2.0** | Team sync | Shared workspaces, shared thread history, per-seat auth. This is when Fixy Code grows an opinionated server, not before. |

---

## 8. Three Things to Lock in the First 30 Minutes

If a future reader of this plan is about to start implementation, these three decisions must be verifiable before any code is written. If any of them drifts, this plan is invalidated until it's updated.

### 1. The GitHub org and npm scope exist and are ours

- Create `github.com/fixy-ai/fixy-code` as a **private repo** with an MIT `LICENSE` file at the root.
- On npmjs.com, reserve the `@fixy` org. Publish a single stub `@fixy/cli@0.0.0` package with just a README pointing at the repo. If `@fixy` is taken, immediately fall back to `@fixy-ai` and update every package name in this plan in a single commit.
- Verify that `pnpm add @fixy/cli` and `npm view @fixy/cli` both resolve to our stub.

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

---

## 9. Session Log

> Append an entry every session. Do not mutate prior entries.

### 2026-04-11 — Plan written

- Author: Claude Opus 4.6 (1M context), acting on the user's brief.
- Sources: `gpt-discussion.txt`, `claude-discussion.txt`, Paperclip reference codebase (`packages/adapters/claude-local/`, `packages/adapters/codex-local/`, `packages/adapter-utils/src/server-utils.ts`, `server/src/adapters/registry.ts`, `adapter-plugin.md`).
- Status: All 12 steps drafted. Locked decisions mirrored from the user's brief. No code written yet. Awaiting the "first 30 minutes" verification pass before Step 1.
