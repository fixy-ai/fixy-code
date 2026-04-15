// packages/core/src/adapter.ts

import type { FixyMessage, FixyPatch } from './thread.js';

export interface FixyAgent {
  /** Stable handle without '@', e.g. "claude", "codex". */
  id: string;
  /** Display name shown in the terminal. */
  name: string;
}

export interface FixyThreadContext {
  threadId: string;
  projectRoot: string; // absolute path to the git repo the thread lives in
  worktreePath: string; // absolute path to the (thread, agent) worktree
  repoRef: string | null; // branch or commit the worktree was created from
}

export interface FixyExecutionContext {
  runId: string; // unique per adapter invocation
  agent: FixyAgent; // which adapter is being invoked
  threadContext: FixyThreadContext;
  /** Full normalized message history Fixy decided to send this turn. */
  messages: FixyMessage[];
  /** Fresh user input for this turn, already stripped of the @mention prefix. */
  prompt: string;
  /** Opaque adapter-owned state from the previous turn in this thread. */
  session: FixySession | null;
  /** Thread-level extra CLI flags for this adapter (overrides global settings). */
  adapterArgs?: Record<string, string>;
  /** Streamed stdout/stderr chunks. Adapters MUST call this. */
  onLog: (stream: 'stdout' | 'stderr', chunk: string, agentId?: string) => void;
  /** Structured events (thinking, tool use, content) for real-time activity display. */
  onEvent?: (event: AdapterEvent) => void;
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
  /** Estimated input token count for this turn (best-effort, undefined if unavailable). */
  inputTokens?: number;
  /** Estimated output token count for this turn (best-effort, undefined if unavailable). */
  outputTokens?: number;
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
  env: Record<string, string>; // already redacted of secrets by the adapter
}

// ---------------------------------------------------------------------------
// Structured adapter events — emitted during execution for real-time display
// ---------------------------------------------------------------------------

export type AdapterEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; file?: string; description?: string }
  | { type: 'tool_end'; name: string; status: 'success' | 'error' }
  | { type: 'content'; text: string };

export interface FixyModelInfo {
  id: string;
  description?: string;
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
  /** Return the currently active model identifier (e.g. "claude-sonnet-4-5"), or null. */
  getActiveModel?(): Promise<string | null>;
  /** Return the list of available models for this adapter. */
  listModels?(): Promise<FixyModelInfo[]>;
}

export interface FixyProbeResult {
  available: boolean;
  version: string | null;
  authStatus: 'ok' | 'needs_login' | 'unknown';
  detail: string | null;
}
