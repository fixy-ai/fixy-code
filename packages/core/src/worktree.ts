// packages/core/src/worktree.ts

import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseUnifiedDiff } from './diff-parser.js';
import { getWorktreesDir } from './paths.js';
import type { FixyPatch } from './thread.js';

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name, e.g. "fixy/<threadId>-<agentId>" */
  branch: string;
  agentId: string;
  threadId: string;
}

export class WorktreeManager {
  /**
   * Idempotent — returns an existing worktree handle or creates a new one.
   */
  async ensure(projectRoot: string, threadId: string, agentId: string): Promise<WorktreeHandle> {
    const worktreePath = join(getWorktreesDir(threadId), agentId);
    const branch = `fixy/${threadId}-${agentId}`;

    const exists = await this.#pathExists(worktreePath);

    if (!exists) {
      // Ensure parent directories exist before running git worktree add.
      // git worktree add creates the leaf directory itself — only create the parent.
      await mkdir(dirname(worktreePath), { recursive: true });

      await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branch], {
        cwd: projectRoot,
      });
    }

    return { path: worktreePath, branch, agentId, threadId };
  }

  /**
   * Runs `git diff --no-color` in the worktree and parses the output into
   * FixyPatch objects.  Returns an empty array when there are no changes.
   */
  async collectPatches(handle: WorktreeHandle): Promise<FixyPatch[]> {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color'], { cwd: handle.path });

    if (!stdout || stdout.trim().length === 0) {
      return [];
    }

    return parseUnifiedDiff(stdout, handle.path);
  }

  /**
   * Removes the worktree and its branch, then re-provisions a fresh one.
   */
  async reset(handle: WorktreeHandle, projectRoot: string): Promise<void> {
    await this.#removeWorktree(handle, projectRoot);
    await this.ensure(projectRoot, handle.threadId, handle.agentId);
  }

  /**
   * Permanently removes the worktree and its tracking branch.
   * Does NOT re-provision.
   */
  async remove(handle: WorktreeHandle, projectRoot: string): Promise<void> {
    await this.#removeWorktree(handle, projectRoot);
  }

  /**
   * Lists all WorktreeHandles for the given threadId by reading the worktrees
   * directory on disk.  Returns an empty array when no worktrees exist yet.
   */
  async list(threadId: string): Promise<WorktreeHandle[]> {
    const dir = getWorktreesDir(threadId);

    const dirExists = await this.#pathExists(dir);
    if (!dirExists) {
      return [];
    }

    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        path: join(dir, e.name),
        branch: `fixy/${threadId}-${e.name}`,
        agentId: e.name,
        threadId,
      }));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #removeWorktree(handle: WorktreeHandle, projectRoot: string): Promise<void> {
    await execFileAsync('git', ['worktree', 'remove', '--force', handle.path], {
      cwd: projectRoot,
    });

    await execFileAsync('git', ['branch', '-D', handle.branch], { cwd: projectRoot });
  }

  async #pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }
}
