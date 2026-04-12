// packages/core/src/__tests__/store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { LocalThreadStore } from '../store.js';
import type { FixyMessage } from '../thread.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeMessage(content: string, role: 'user' | 'agent' | 'system' = 'user'): FixyMessage {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    role,
    agentId: role === 'agent' ? 'claude' : null,
    content,
    runId: role === 'agent' ? randomUUID() : null,
    dispatchedTo: role === 'user' ? ['claude'] : [],
    patches: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let store: LocalThreadStore;
const PROJECT_ROOT = '/tmp/fake-project';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fixy-test-'));
  process.env['FIXY_HOME'] = tempDir;
  store = new LocalThreadStore();
  await store.init();
});

afterEach(async () => {
  delete process.env['FIXY_HOME'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalThreadStore', () => {
  describe('createThread', () => {
    it('creates a thread with correct projectRoot, status=active, and an id', async () => {
      const thread = await store.createThread(PROJECT_ROOT);

      expect(thread.id).toBeTruthy();
      expect(typeof thread.id).toBe('string');
      expect(thread.projectRoot).toBe(PROJECT_ROOT);
      expect(thread.status).toBe('active');

      // Verify the thread is also persisted on disk
      const loaded = await store.getThread(thread.id, PROJECT_ROOT);
      expect(loaded.id).toBe(thread.id);
      expect(loaded.projectRoot).toBe(PROJECT_ROOT);
      expect(loaded.status).toBe('active');
    });
  });

  describe('appendMessage', () => {
    it('appends multiple messages in order and persists them to disk', async () => {
      const thread = await store.createThread(PROJECT_ROOT);

      const msg1 = makeMessage('first message', 'user');
      const msg2 = makeMessage('second message', 'agent');
      const msg3 = makeMessage('third message', 'user');

      await store.appendMessage(thread.id, PROJECT_ROOT, msg1);
      await store.appendMessage(thread.id, PROJECT_ROOT, msg2);
      await store.appendMessage(thread.id, PROJECT_ROOT, msg3);

      // Reload from disk to confirm persistence
      const loaded = await store.getThread(thread.id, PROJECT_ROOT);
      expect(loaded.messages).toHaveLength(3);
      expect(loaded.messages[0]).toHaveProperty('content', 'first message');
      expect(loaded.messages[1]).toHaveProperty('content', 'second message');
      expect(loaded.messages[2]).toHaveProperty('content', 'third message');
    });
  });

  describe('getThread / listThreads', () => {
    it('lists both threads and returns the correct one by id', async () => {
      const threadA = await store.createThread(PROJECT_ROOT);
      const threadB = await store.createThread(PROJECT_ROOT);

      const threads = await store.listThreads(PROJECT_ROOT);
      const ids = threads.map((t) => t.id);
      expect(ids).toContain(threadA.id);
      expect(ids).toContain(threadB.id);
      expect(threads).toHaveLength(2);

      const loadedA = await store.getThread(threadA.id, PROJECT_ROOT);
      expect(loadedA.id).toBe(threadA.id);

      const loadedB = await store.getThread(threadB.id, PROJECT_ROOT);
      expect(loadedB.id).toBe(threadB.id);
    });
  });

  describe('archiveThread', () => {
    it('sets status to "archived" and persists the change', async () => {
      const thread = await store.createThread(PROJECT_ROOT);
      expect(thread.status).toBe('active');

      const archived = await store.archiveThread(thread.id, PROJECT_ROOT);
      expect(archived.status).toBe('archived');

      // Reload from disk to confirm persistence
      const loaded = await store.getThread(thread.id, PROJECT_ROOT);
      expect(loaded.status).toBe('archived');
    });
  });

  describe('atomic write safety', () => {
    it('leaves no .tmp files in the threads directory after writes', async () => {
      const thread = await store.createThread(PROJECT_ROOT);
      await store.appendMessage(thread.id, PROJECT_ROOT, makeMessage('hello'));

      // Derive the threads directory using the same path logic the store uses
      const { getThreadsDir } = await import('../paths.js');
      const threadsDir = getThreadsDir(PROJECT_ROOT);

      const entries = await readdir(threadsDir);
      const tmpFiles = entries.filter((name) => name.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('appendMessage on non-existent thread', () => {
    it('throws an error containing "Thread not found"', async () => {
      const fakeId = randomUUID();
      const msg = makeMessage('should fail');

      await expect(store.appendMessage(fakeId, PROJECT_ROOT, msg)).rejects.toThrow(
        'Thread not found',
      );
    });
  });
});
