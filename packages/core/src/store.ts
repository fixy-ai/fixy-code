// packages/core/src/store.ts

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import type { FixyMessage, FixyThread } from './thread.js';
import {
  computeProjectId,
  getFixyHome,
  getProjectFile,
  getThreadFile,
  getThreadsDir,
} from './paths.js';

export class LocalThreadStore {
  /**
   * Ensures the top-level `projects/` and `worktrees/` directories exist
   * under the Fixy home directory.
   */
  async init(): Promise<void> {
    const home = getFixyHome();
    await Promise.all([
      mkdir(join(home, 'projects'), { recursive: true }),
      mkdir(join(home, 'worktrees'), { recursive: true }),
    ]);
  }

  /**
   * Creates a new thread for the given project root, persisting it to disk.
   * Writes project.json if it does not already exist.
   */
  async createThread(projectRoot: string): Promise<FixyThread> {
    const id = uuidv7();
    const projectId = computeProjectId(projectRoot);
    const now = new Date().toISOString();

    // Ensure project and threads directories exist.
    await mkdir(getThreadsDir(projectRoot), { recursive: true });

    // Write project.json only if it doesn't already exist (flag 'wx').
    const projectFile = getProjectFile(projectRoot);
    try {
      await writeFile(
        projectFile,
        JSON.stringify({ projectId, projectRoot, createdAt: now }, null, 2),
        { flag: 'wx' },
      );
    } catch (err) {
      // EEXIST means the file already exists — that's fine.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    const thread: FixyThread = {
      id,
      projectId,
      projectRoot,
      createdAt: now,
      updatedAt: now,
      title: null,
      status: 'active',
      workerModel: 'claude',
      agentSessions: {},
      worktrees: {},
      messages: [],
    };

    await this._writeAtomic(getThreadFile(projectRoot, id), thread);

    return thread;
  }

  /**
   * Appends a message to an existing thread and persists the update.
   * Throws if the thread does not exist.
   */
  async appendMessage(
    threadId: string,
    projectRoot: string,
    message: FixyMessage,
  ): Promise<FixyThread> {
    const thread = await this.getThread(threadId, projectRoot);

    thread.messages.push(message);
    thread.updatedAt = new Date().toISOString();

    await this._writeAtomic(getThreadFile(projectRoot, threadId), thread);

    return thread;
  }

  /**
   * Reads and returns a single thread by id.
   * Throws if the thread file does not exist.
   */
  async getThread(threadId: string, projectRoot: string): Promise<FixyThread> {
    const threadPath = getThreadFile(projectRoot, threadId);
    try {
      const raw = await readFile(threadPath, 'utf8');
      return JSON.parse(raw) as FixyThread;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Thread not found: ${threadId}`, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Returns all threads for the given project root.
   * Returns an empty array if the threads directory does not exist yet.
   */
  async listThreads(projectRoot: string): Promise<FixyThread[]> {
    const threadsDir = getThreadsDir(projectRoot);
    let entries: string[];
    try {
      entries = await readdir(threadsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const jsonFiles = entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));

    const threads = await Promise.all(
      jsonFiles.map(async (file) => {
        const raw = await readFile(join(threadsDir, file), 'utf8');
        return JSON.parse(raw) as FixyThread;
      }),
    );

    return threads;
  }

  /**
   * Sets the thread status to "archived" and persists the change.
   * Throws if the thread does not exist.
   */
  async archiveThread(threadId: string, projectRoot: string): Promise<FixyThread> {
    const thread = await this.getThread(threadId, projectRoot);

    thread.status = 'archived';
    thread.updatedAt = new Date().toISOString();

    await this._writeAtomic(getThreadFile(projectRoot, threadId), thread);

    return thread;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Atomically writes an object as formatted JSON: write to *.tmp, then rename. */
  private async _writeAtomic(destPath: string, data: unknown): Promise<void> {
    const tmpPath = `${destPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmpPath, destPath);
  }
}
