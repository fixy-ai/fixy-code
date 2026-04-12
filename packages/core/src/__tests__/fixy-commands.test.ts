import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixyCommandRunner } from '../fixy-commands.js';
import type { FixyCommandContext } from '../fixy-commands.js';
import { AdapterRegistry } from '../registry.js';
import { LocalThreadStore } from '../store.js';
import type { WorktreeManager } from '../worktree.js';
import type { FixyAdapter, FixyExecutionContext, FixyExecutionResult } from '../adapter.js';
import type { FixyThread } from '../thread.js';
import { getThreadFile } from '../paths.js';

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
        summary: `response from ${id}`,
        session: null,
        patches: [],
        warnings: [],
        errorMessage: null,
      })),
  };
}

const stubWorktreeManager = {
  ensure: vi.fn(async () => ({ path: '', branch: '', agentId: '', threadId: '' })),
  collectPatches: vi.fn(async () => []),
  reset: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  list: vi.fn(async () => []),
} as unknown as WorktreeManager;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FixyCommandRunner', () => {
  let tmpDir: string;
  let store: LocalThreadStore;
  let thread: FixyThread;
  let registry: AdapterRegistry;
  let runner: FixyCommandRunner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fixy-cmd-test-'));
    process.env['FIXY_HOME'] = tmpDir;
    store = new LocalThreadStore();
    await store.init();
    thread = await store.createThread('/tmp/fake-project');
    registry = new AdapterRegistry();
    runner = new FixyCommandRunner();

    // Reset all vi.fn() call history between tests
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env['FIXY_HOME'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides?: Partial<FixyCommandContext>): FixyCommandContext {
    return {
      thread,
      rest: '',
      store,
      registry,
      worktreeManager: stubWorktreeManager,
      onLog: () => {},
      signal: AbortSignal.timeout(5000),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Test 1: /worker <id> — persists workerModel change
  // -------------------------------------------------------------------------
  it('/worker codex — persists workerModel change and appends system message', async () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));

    expect(thread.workerModel).toBe('claude');

    await runner.run(makeCtx({ rest: '/worker codex' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    expect(fresh.workerModel).toBe('codex');

    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content === 'worker set to codex',
    );
    expect(sysMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: /worker unknown — throws for unknown adapter
  // -------------------------------------------------------------------------
  it('/worker unknown — throws for unknown adapter', async () => {
    registry.register(createStubAdapter('claude', 'Claude'));

    await expect(runner.run(makeCtx({ rest: '/worker unknown' }))).rejects.toThrow(
      /Unknown adapter/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: /all build something — returns stub message
  // -------------------------------------------------------------------------
  it('/all build something — returns stub collaboration message', async () => {
    await runner.run(makeCtx({ rest: '/all build something' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('collaboration engine not yet implemented'),
    );
    expect(sysMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: /settings — returns stub message
  // -------------------------------------------------------------------------
  it('/settings — returns stub message', async () => {
    await runner.run(makeCtx({ rest: '/settings' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content === 'settings command not yet implemented',
    );
    expect(sysMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 5: /reset — clears agentSessions
  // -------------------------------------------------------------------------
  it('/reset — clears agentSessions and appends confirmation message', async () => {
    // Mutate the in-memory thread to have an active session.
    thread.agentSessions = { claude: { sessionId: 'sess-1', params: {} } };
    thread.worktrees = { claude: '/tmp/worktree-claude' };

    // Persist the modified thread to disk so store.getThread returns it.
    const threadFilePath = getThreadFile(thread.projectRoot, thread.id);
    await writeFile(threadFilePath, JSON.stringify(thread, null, 2), 'utf8');

    await runner.run(makeCtx({ rest: '/reset' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    expect(fresh.agentSessions).toEqual({});

    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('thread reset'),
    );
    expect(sysMsg).toBeDefined();

    // Verify worktreeManager.reset was called for the claude worktree entry.
    expect(stubWorktreeManager.reset as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 6: /status — shows adapter probe results
  // -------------------------------------------------------------------------
  it('/status — lists adapter probe results including current workerModel', async () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));

    await runner.run(makeCtx({ rest: '/status' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    expect(fresh.messages.length).toBeGreaterThan(0);

    const sysMsg = fresh.messages[fresh.messages.length - 1];
    expect(sysMsg?.role).toBe('system');

    const content = sysMsg?.content ?? '';
    expect(content).toContain('claude');
    expect(content).toContain('codex');
    expect(content).toContain('yes'); // available: yes
    expect(content).toContain('1.0.0'); // version
    expect(content).toContain(thread.workerModel); // current workerModel line
  });

  // -------------------------------------------------------------------------
  // Test 7: Bare @fixy prompt — routes through worker adapter
  // -------------------------------------------------------------------------
  it('bare prompt — routes through worker adapter and appends agent message with agentId=fixy', async () => {
    const customExecute = async (_ctx: FixyExecutionContext): Promise<FixyExecutionResult> => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: 'worker response here',
      session: { sessionId: 'new-sess', params: {} },
      patches: [],
      warnings: [],
      errorMessage: null,
    });

    registry.register(createStubAdapter('claude', 'Claude', customExecute));
    thread.workerModel = 'claude';

    await runner.run(makeCtx({ rest: 'explain this' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const agentMsg = fresh.messages.find((m) => m.role === 'agent');

    expect(agentMsg).toBeDefined();
    expect(agentMsg?.agentId).toBe('fixy');
    expect(agentMsg?.content).toBe('worker response here');
  });
});
