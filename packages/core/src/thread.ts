// packages/core/src/thread.ts

import type { FixySession } from './adapter.js';

export type FixyRole = 'user' | 'agent' | 'system';

export interface FixyThread {
  id: string; // uuid v7
  projectId: string; // sha1 of projectRoot
  projectRoot: string; // absolute path
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  title: string | null; // user-editable, null until first message
  status: 'active' | 'archived';
  workerModel: string; // current @fixy worker adapter id, e.g. "claude"
  agentSessions: Record<string, FixySession | null>; // per-adapter resume state
  worktrees: Record<string, string>; // agentId → absolute worktree path
  messages: FixyMessage[];
}

export interface FixyMessage {
  id: string; // uuid v7, monotonic by createdAt
  createdAt: string; // ISO 8601
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

export type { FixySession } from './adapter.js';
