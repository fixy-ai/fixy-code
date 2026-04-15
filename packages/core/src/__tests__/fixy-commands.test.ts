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
  // Test 3: /all without prompt — shows usage message
  // -------------------------------------------------------------------------
  it('/all without prompt — shows usage message', async () => {
    await runner.run(makeCtx({ rest: '/all' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('/all requires a prompt'),
    );
    expect(sysMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 3b: /all with no adapters — shows error
  // -------------------------------------------------------------------------
  it('/all with no adapters — shows error', async () => {
    await runner.run(makeCtx({ rest: '/all build something' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('at least one registered adapter'),
    );
    expect(sysMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 3c: /all solo mode — single adapter skips discussion
  // -------------------------------------------------------------------------
  it('/all solo mode — single adapter runs plan+execute without discussion', async () => {
    let callCount = 0;
    const soloAdapter = createStubAdapter('claude', 'Claude', async (_ctx) => {
      callCount++;
      // First call: plan breakdown → return numbered list
      if (callCount === 1) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: '1. Create auth module\n2. Add login endpoint',
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      // Second call: worker execution
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: 'Implemented auth module and login endpoint',
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });
    registry.register(soloAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all build auth',
      onLog: (_s, msg) => logs.push(msg),
    }));

    expect(logs.some((l) => l.includes('Solo mode'))).toBe(true);
    expect(logs.some((l) => l.includes('Plan'))).toBe(true);
    expect(logs.some((l) => l.includes('Execute'))).toBe(true);

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const completionMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('Complete'),
    );
    expect(completionMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 3d: /all multi-adapter — full discussion + worker + review
  // -------------------------------------------------------------------------
  it('/all multi-adapter — runs discussion, plan, worker execution, and review', async () => {
    // Thinker agrees immediately
    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree with the plan. LGTM.\n1. Create util function\n2. Add tests',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    let workerCalls = 0;
    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => {
      workerCalls++;
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: 'Done implementing the requested changes.',
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all build a utility',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Discussion should have ended early due to agreement
    expect(logs.some((l) => l.includes('Discuss'))).toBe(true);
    expect(logs.some((l) => l.includes('Plan'))).toBe(true);
    expect(logs.some((l) => l.includes('Execute'))).toBe(true);
    expect(logs.some((l) => l.includes('Final review'))).toBe(true);
    expect(workerCalls).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 3e: /all review finds issues — worker gets fix attempt
  // -------------------------------------------------------------------------
  it('/all review issues — worker retries when thinker flags issues', async () => {
    let thinkerCalls = 0;
    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => {
      thinkerCalls++;
      // Discussion: agree immediately
      if (thinkerCalls <= 1) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: 'I agree.\n1. Fix the bug',
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      // Plan breakdown
      if (thinkerCalls === 2) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: '1. Fix the bug',
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      // First review: flag issue
      if (thinkerCalls === 3) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: 'ISSUES: Missing error handling',
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      // Second review: approve
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: 'APPROVED',
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });

    let workerCalls = 0;
    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => {
      workerCalls++;
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: `Worker output attempt ${workerCalls}`,
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all fix the bug',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Worker should have been called at least twice (initial + fix)
    expect(workerCalls).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('Review'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3f: /all caps TODOs at 20
  // -------------------------------------------------------------------------
  it('/all caps TODO list at 20 items', async () => {
    const longList = Array.from({ length: 25 }, (_, i) => `${i + 1}. Task item ${i + 1}`).join('\n');
    let callCount = 0;
    const soloAdapter = createStubAdapter('claude', 'Claude', async () => {
      callCount++;
      if (callCount === 1) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: longList,
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: 'Done',
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });
    registry.register(soloAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all build a big task with many items',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Should report exactly 20 TODOs
    expect(logs.some((l) => l.includes('20 steps'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: /settings — prints current settings
  // -------------------------------------------------------------------------
  it('/settings — prints current settings key/value pairs', async () => {
    await runner.run(makeCtx({ rest: '/settings' }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const sysMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('defaultWorker:'),
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

  // -------------------------------------------------------------------------
  // Test 8: @all Phase 6 — code review approved
  // -------------------------------------------------------------------------
  it('@all Phase 6 — code review approved shows "all reviews passed"', async () => {
    // Mock review module
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('diff --git a/file.ts\n+added line');
    const runReviewLoopSpy = vi.spyOn(reviewModule, 'runReviewLoop').mockResolvedValue({
      approved: true,
      rounds: 1,
      allIssues: [],
      warnings: [],
      escalated: false,
    });

    // Thinker that agrees to everything
    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree. APPROVED\n1. Do the thing',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'Done.',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all implement feature X',
      onLog: (_s, msg) => logs.push(msg),
    }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const completionMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('all reviews passed'),
    );
    expect(completionMsg).toBeDefined();
    expect(logs.some(l => l.includes('Code review'))).toBe(true);

    collectGitDiffSpy.mockRestore();
    runReviewLoopSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 9: @all Phase 6 — code review escalated
  // -------------------------------------------------------------------------
  it('@all Phase 6 — escalation shows "review escalated" panel', async () => {
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('diff --git a/file.ts\n+bad code');
    const runReviewLoopSpy = vi.spyOn(reviewModule, 'runReviewLoop').mockResolvedValue({
      approved: false,
      rounds: 3,
      allIssues: [
        { severity: 'HIGH' as const, file: 'src/main.ts', line: 10, description: 'Missing null check', agentId: 'codex' },
      ],
      warnings: [],
      escalated: true,
    });

    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree. APPROVED\n1. Do the thing',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'Done.',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all implement feature Y',
      onLog: (_s, msg) => logs.push(msg),
    }));

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const completionMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('review escalated'),
    );
    expect(completionMsg).toBeDefined();
    expect(logs.some(l => l.includes('YOU DECIDE'))).toBe(true);

    collectGitDiffSpy.mockRestore();
    runReviewLoopSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 10: @all Phase 6 — no code changes skips review
  // -------------------------------------------------------------------------
  it('@all Phase 6 — no code changes shows "no changes detected"', async () => {
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('');

    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree. APPROVED\n1. Do the thing',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'Done.',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all implement feature Z',
      onLog: (_s, msg) => logs.push(msg),
    }));

    expect(logs.some(l => l.includes('no changes detected'))).toBe(true);

    collectGitDiffSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 11: @all Phase 6 solo mode — worker reviews own code
  // -------------------------------------------------------------------------
  it('@all Phase 6 solo mode — single adapter reviews its own code', async () => {
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('diff --git a/file.ts\n+code');
    const runReviewLoopSpy = vi.spyOn(reviewModule, 'runReviewLoop').mockResolvedValue({
      approved: true,
      rounds: 1,
      allIssues: [],
      warnings: [],
      escalated: false,
    });

    let callCount = 0;
    const soloAdapter = createStubAdapter('claude', 'Claude', async () => {
      callCount++;
      if (callCount === 1) {
        return {
          exitCode: 0, signal: null, timedOut: false,
          summary: '1. Create module\n2. Add tests',
          session: null, patches: [], warnings: [], errorMessage: null,
        };
      }
      return {
        exitCode: 0, signal: null, timedOut: false,
        summary: 'Done implementing.',
        session: null, patches: [], warnings: [], errorMessage: null,
      };
    });
    registry.register(soloAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all build something cool',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Verify runReviewLoop was called with max 2 rounds (solo mode cap)
    expect(runReviewLoopSpy).toHaveBeenCalledOnce();
    const config = runReviewLoopSpy.mock.calls[0][0];
    expect(config.maxAutoFixRounds).toBeLessThanOrEqual(2);

    // Verify solo mode completion message
    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const completionMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('solo mode'),
    );
    expect(completionMsg).toBeDefined();

    collectGitDiffSpy.mockRestore();
    runReviewLoopSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 12: /all question intent — only discussion, no plan/execute
  // -------------------------------------------------------------------------
  it('/all question — skips plan/execute, only runs discussion', async () => {
    const adapter1 = createStubAdapter('claude', 'Claude');
    const adapter2 = createStubAdapter('codex', 'Codex');
    registry.register(adapter1);
    registry.register(adapter2);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all what framework should we use?',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Should have 'Complete' but NOT 'Plan' or 'Execute' phase headers
    expect(logs.some((l) => l.includes('Complete'))).toBe(true);
    expect(logs.some((l) => l.includes('Plan'))).toBe(false);
    expect(logs.some((l) => l.includes('Execute'))).toBe(false);

    const fresh = await store.getThread(thread.id, thread.projectRoot);
    const completionMsg = fresh.messages.find(
      (m) => m.role === 'system' && m.content.includes('question answered'),
    );
    expect(completionMsg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 13: /all task intent — full 6-phase pipeline
  // -------------------------------------------------------------------------
  it('/all task — runs full pipeline with plan and execute', async () => {
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('');

    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree. APPROVED\n1. Build the API',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'Done building the API.',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all build a REST API',
      onLog: (_s, msg) => logs.push(msg),
    }));

    expect(logs.some((l) => l.includes('Discuss'))).toBe(true);
    expect(logs.some((l) => l.includes('Plan'))).toBe(true);
    expect(logs.some((l) => l.includes('Execute'))).toBe(true);

    collectGitDiffSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 14: /all! force flag — full pipeline even for questions
  // -------------------------------------------------------------------------
  it('/all! force — runs full pipeline even for questions', async () => {
    const reviewModule = await import('../review.js');
    const collectGitDiffSpy = vi.spyOn(reviewModule, 'collectGitDiff').mockResolvedValue('');

    const thinkerAdapter = createStubAdapter('codex', 'Codex', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'I agree. APPROVED\n1. Research frameworks',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    const workerAdapterObj = createStubAdapter('claude', 'Claude', async () => ({
      exitCode: 0, signal: null, timedOut: false,
      summary: 'Done researching.',
      session: null, patches: [], warnings: [], errorMessage: null,
    }));

    registry.register(workerAdapterObj);
    registry.register(thinkerAdapter);
    thread.workerModel = 'claude';

    const logs: string[] = [];
    await runner.run(makeCtx({
      rest: '/all! what should we use?',
      onLog: (_s, msg) => logs.push(msg),
    }));

    // Force flag should run full pipeline despite question intent
    expect(logs.some((l) => l.includes('Discuss'))).toBe(true);
    expect(logs.some((l) => l.includes('Plan'))).toBe(true);
    expect(logs.some((l) => l.includes('Execute'))).toBe(true);
  });
});
