// packages/core/src/__tests__/compact.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { TurnController } from '../turn.js';
import { FixyCommandRunner } from '../fixy-commands.js';
import type { FixyCommandContext } from '../fixy-commands.js';
import { AdapterRegistry } from '../registry.js';
import { LocalThreadStore } from '../store.js';
import type { FixyAdapter, FixyExecutionContext, FixyExecutionResult } from '../adapter.js';
import type { FixyThread } from '../thread.js';
import type { WorktreeManager } from '../worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubAdapter(
  id: string,
  name: string,
  executeFn?: (ctx: FixyExecutionContext) => Promise<FixyExecutionResult>,
): FixyAdapter {
  return {
    id,
    name,
    probe: async () => ({
      available: true,
      version: '1.0.0',
      authStatus: 'ok' as const,
      detail: null,
    }),
    execute:
      executeFn ??
      (async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `summary from ${id}`,
        session: null,
        patches: [],
        warnings: [],
        errorMessage: null,
      })),
  };
}

const stubWorktreeManager = {
  ensure: async () => ({ path: '', branch: '', agentId: '', threadId: '' }),
  collectPatches: async () => [],
  reset: async () => {},
  remove: async () => {},
  list: async () => [],
} as unknown as WorktreeManager;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('compact', () => {
  let tmpDir: string;
  let store: LocalThreadStore;
  let thread: FixyThread;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fixy-compact-test-'));
    process.env['FIXY_HOME'] = tmpDir;

    store = new LocalThreadStore();
    await store.init();
    thread = await store.createThread('/tmp/fake-project');

    registry = new AdapterRegistry();
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));
  });

  afterEach(async () => {
    delete process.env['FIXY_HOME'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides?: Partial<FixyCommandContext>): FixyCommandContext {
    return {
      thread,
      rest: '/compact',
      store,
      registry,
      worktreeManager: stubWorktreeManager,
      onLog: () => {},
      signal: AbortSignal.timeout(5000),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Test 1: /compact appends a system message with compacted: true
  // -------------------------------------------------------------------------

  it('/compact appends a system message with compacted: true', async () => {
    // Seed some messages first
    await store.appendMessage(thread.id, thread.projectRoot, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'user',
      agentId: null,
      content: 'hello',
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
    });

    const runner = new FixyCommandRunner();
    await runner.run(makeCtx({ rest: '/compact' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);
    const compactMsg = updated.messages.find((m) => m.compacted === true);

    expect(compactMsg).toBeDefined();
    expect(compactMsg?.role).toBe('system');
    expect(compactMsg?.content).toBe('summary from claude'); // worker is 'claude'
    expect(compactMsg?.compacted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: turn.ts sends only compact message + messages after it
  // -------------------------------------------------------------------------

  it('turn.ts message building sends only compact message + messages after it', async () => {
    // Append 3 messages: user, agent, then compact system message, then another user message
    const msgBefore1 = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'user' as const,
      agentId: null,
      content: 'old message 1',
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    const msgBefore2 = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'agent' as const,
      agentId: 'claude',
      content: 'old agent response',
      runId: randomUUID(),
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    const compactMsg = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'system' as const,
      agentId: null,
      content: 'this is the compact summary',
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
      compacted: true as const,
    };

    await store.appendMessage(thread.id, thread.projectRoot, msgBefore1);
    await store.appendMessage(thread.id, thread.projectRoot, msgBefore2);
    await store.appendMessage(thread.id, thread.projectRoot, compactMsg);

    // Re-read thread so it has all messages
    thread = await store.getThread(thread.id, thread.projectRoot);

    // Track what messages the adapter receives
    let capturedMessages: typeof thread.messages = [];
    registry.unregister('claude');
    registry.register(
      createStubAdapter('claude', 'Claude', async (ctx) => {
        capturedMessages = [...ctx.messages];
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: 'after compact response',
          session: null,
          patches: [],
          warnings: [],
          errorMessage: null,
        };
      }),
    );

    const controller = new TurnController();
    await controller.runTurn({
      thread,
      input: '@claude do something',
      registry,
      store,
      onLog: () => {},
      signal: AbortSignal.timeout(5000),
    });

    // Should only have received: compact message + user "@claude do something" (appended before dispatch)
    expect(capturedMessages.find((m) => m.content === 'old message 1')).toBeUndefined();
    expect(capturedMessages.find((m) => m.content === 'old agent response')).toBeUndefined();
    expect(capturedMessages.find((m) => m.compacted === true)).toBeDefined();
    expect(capturedMessages.find((m) => m.content === 'this is the compact summary')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 3: /compact @claude uses Claude adapter specifically
  // -------------------------------------------------------------------------

  it('/compact @claude uses the claude adapter specifically', async () => {
    let claudeCalled = false;
    let codexCalled = false;

    registry.unregister('claude');
    registry.unregister('codex');

    registry.register(
      createStubAdapter('claude', 'Claude', async () => {
        claudeCalled = true;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: 'claude summary',
          session: null,
          patches: [],
          warnings: [],
          errorMessage: null,
        };
      }),
    );
    registry.register(
      createStubAdapter('codex', 'Codex', async () => {
        codexCalled = true;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: 'codex summary',
          session: null,
          patches: [],
          warnings: [],
          errorMessage: null,
        };
      }),
    );

    // Default worker is 'claude', but we explicitly pass @codex
    thread.workerModel = 'claude';
    const runner = new FixyCommandRunner();
    await runner.run(makeCtx({ rest: '/compact @codex', thread }));

    expect(codexCalled).toBe(true);
    expect(claudeCalled).toBe(false);

    const updated = await store.getThread(thread.id, thread.projectRoot);
    const compactMsg = updated.messages.find((m) => m.compacted === true);
    expect(compactMsg?.content).toBe('codex summary');
  });

  // -------------------------------------------------------------------------
  // Test 4: Full history on disk is untouched after compact
  // -------------------------------------------------------------------------

  it('full history on disk is untouched after compact', async () => {
    // Append some messages before running /compact
    const original1 = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'user' as const,
      agentId: null,
      content: 'first message',
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    const original2 = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'agent' as const,
      agentId: 'claude',
      content: 'first agent reply',
      runId: randomUUID(),
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    await store.appendMessage(thread.id, thread.projectRoot, original1);
    await store.appendMessage(thread.id, thread.projectRoot, original2);

    thread = await store.getThread(thread.id, thread.projectRoot);

    const runner = new FixyCommandRunner();
    await runner.run(makeCtx({ rest: '/compact', thread }));

    const updated = await store.getThread(thread.id, thread.projectRoot);

    // Original messages must still be present at their original positions
    expect(updated.messages[0]?.content).toBe('first message');
    expect(updated.messages[1]?.content).toBe('first agent reply');

    // Compact summary must be appended as a NEW message (not a replacement)
    const compactMsg = updated.messages.find((m) => m.compacted === true);
    expect(compactMsg).toBeDefined();
    expect(updated.messages.length).toBe(3); // original 2 + 1 compact summary
  });
});
