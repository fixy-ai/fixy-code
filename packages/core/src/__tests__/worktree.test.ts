// packages/core/src/__tests__/worktree.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { WorktreeManager } from '../worktree.js';
import type { WorktreeHandle } from '../worktree.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let projectRoot: string;
let manager: WorktreeManager;
const THREAD_ID = 'test-thread-001';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fixy-wt-test-'));
  process.env['FIXY_HOME'] = join(tempDir, 'fixy-home');

  // Create a real git repo as fixture
  projectRoot = join(tempDir, 'repo');
  await execFileAsync('mkdir', ['-p', projectRoot]);
  await execFileAsync('git', ['init'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot });
  // Need at least one commit for worktrees
  await writeFile(join(projectRoot, 'README.md'), '# Test\n');
  await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: projectRoot });

  manager = new WorktreeManager();
});

afterEach(async () => {
  delete process.env['FIXY_HOME'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorktreeManager', { timeout: 15000 }, () => {
  it('ensure() creates a worktree with correct handle fields', async () => {
    const handle: WorktreeHandle = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    // Shape
    expect(handle.agentId).toBe('claude');
    expect(handle.threadId).toBe(THREAD_ID);
    expect(handle.branch).toBe('fixy/test-thread-001-claude');
    expect(handle.path).toContain('test-thread-001');
    expect(handle.path).toContain('claude');

    // Directory actually exists on disk
    await expect(access(handle.path)).resolves.toBeUndefined();

    // git worktree list shows the path
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot,
    });
    expect(stdout).toContain(handle.path);
  });

  it('ensure() is idempotent — second call returns same handle, no error', async () => {
    const handle1 = await manager.ensure(projectRoot, THREAD_ID, 'claude');
    const handle2 = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    expect(handle2.path).toBe(handle1.path);
    expect(handle2.branch).toBe(handle1.branch);
    expect(handle2.agentId).toBe(handle1.agentId);
    expect(handle2.threadId).toBe(handle1.threadId);
  });

  it('collectPatches() returns patches for modified tracked files', async () => {
    const handle = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    // README.md was tracked from the init commit and is present in the worktree
    await writeFile(join(handle.path, 'README.md'), '# Test\n\nAdded a line.\n');

    const patches = await manager.collectPatches(handle);

    expect(patches).toHaveLength(1);
    expect(patches[0].relativePath).toBe('README.md');
    // One line added
    expect(patches[0].stats.additions).toBeGreaterThanOrEqual(1);
    // Original line counted as deletion since it was replaced
    expect(patches[0].stats.deletions).toBeGreaterThanOrEqual(0);
    expect(patches[0].diff).toContain('diff --git');
  });

  it('collectPatches() returns empty array on clean worktree', async () => {
    const handle = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    const patches = await manager.collectPatches(handle);

    expect(patches).toEqual([]);
  });

  it('reset() re-provisions a clean worktree', async () => {
    const handle = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    // Dirty the worktree
    await writeFile(join(handle.path, 'README.md'), '# Dirty\n');

    await manager.reset(handle, projectRoot);

    // The same path should exist again (re-provisioned)
    await expect(access(handle.path)).resolves.toBeUndefined();

    // collectPatches on the fresh handle should be empty
    const freshHandle = await manager.ensure(projectRoot, THREAD_ID, 'claude');
    const patches = await manager.collectPatches(freshHandle);
    expect(patches).toEqual([]);
  });

  it('remove() permanently removes the worktree directory and its branch', async () => {
    const handle = await manager.ensure(projectRoot, THREAD_ID, 'claude');

    await manager.remove(handle, projectRoot);

    // Directory no longer exists
    await expect(access(handle.path)).rejects.toThrow();

    // Branch is deleted
    const { stdout } = await execFileAsync('git', ['branch', '--list', handle.branch], {
      cwd: projectRoot,
    });
    expect(stdout.trim()).toBe('');
  });

  it('list() returns all worktrees registered for a thread', async () => {
    await manager.ensure(projectRoot, THREAD_ID, 'claude');
    await manager.ensure(projectRoot, THREAD_ID, 'codex');

    const handles = await manager.list(THREAD_ID);

    expect(handles).toHaveLength(2);
    const agentIds = handles.map((h) => h.agentId);
    expect(agentIds).toContain('claude');
    expect(agentIds).toContain('codex');

    // All handles should report the correct threadId
    for (const h of handles) {
      expect(h.threadId).toBe(THREAD_ID);
    }
  });
});
