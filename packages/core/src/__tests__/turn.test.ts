// packages/core/src/__tests__/turn.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnController } from '../turn.js';
import { AdapterRegistry } from '../registry.js';
import { LocalThreadStore } from '../store.js';
import type { FixyAdapter, FixyExecutionContext, FixyExecutionResult } from '../adapter.js';
import type { FixyThread } from '../thread.js';
import type { TurnParams } from '../turn.js';

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TurnController', () => {
  let tmpDir: string;
  let store: LocalThreadStore;
  let thread: FixyThread;
  let registry: AdapterRegistry;
  let controller: TurnController;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fixy-turn-test-'));
    process.env['FIXY_HOME'] = tmpDir;

    store = new LocalThreadStore();
    await store.init();

    thread = await store.createThread('/tmp/fake-project');

    registry = new AdapterRegistry();
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));

    controller = new TurnController();
  });

  afterEach(async () => {
    delete process.env['FIXY_HOME'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeParams(overrides?: Partial<TurnParams>): TurnParams {
    return {
      thread,
      input: '',
      registry,
      store,
      onLog: () => {},
      signal: AbortSignal.timeout(5000),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------

  it('single mention dispatches to the mentioned adapter', async () => {
    await controller.runTurn(makeParams({ input: '@claude hello' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);

    expect(updated.messages).toHaveLength(2);

    const [userMsg, agentMsg] = updated.messages;
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toBe('@claude hello');

    expect(agentMsg.role).toBe('agent');
    expect(agentMsg.agentId).toBe('claude');
    expect(agentMsg.content).toBe('response from claude');
  });

  // -------------------------------------------------------------------------

  it('multi mention dispatches sequentially, second sees first response', async () => {
    const capturedMessages: typeof thread.messages = [];

    registry.unregister('claude');
    registry.unregister('codex');

    registry.register(
      createStubAdapter('claude', 'Claude', async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: 'claude says hi',
        session: null,
        patches: [],
        warnings: [],
        errorMessage: null,
      })),
    );

    registry.register(
      createStubAdapter('codex', 'Codex', async (ctx) => {
        capturedMessages.push(...ctx.messages);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: 'codex says bye',
          session: null,
          patches: [],
          warnings: [],
          errorMessage: null,
        };
      }),
    );

    await controller.runTurn(makeParams({ input: '@claude @codex brainstorm' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);

    expect(updated.messages).toHaveLength(3);
    expect(updated.messages[0].role).toBe('user');
    expect(updated.messages[1].role).toBe('agent');
    expect(updated.messages[1].agentId).toBe('claude');
    expect(updated.messages[2].role).toBe('agent');
    expect(updated.messages[2].agentId).toBe('codex');

    // Codex's execute received messages that include claude's response.
    const claudeResponseInCodexCtx = capturedMessages.find(
      (m) => m.role === 'agent' && m.agentId === 'claude' && m.content === 'claude says hi',
    );
    expect(claudeResponseInCodexCtx).toBeDefined();
  });

  // -------------------------------------------------------------------------

  it('bare message falls to last agent that spoke', async () => {
    const { randomUUID } = await import('node:crypto');

    // Manually append an agent message from codex so it is the last agent.
    await store.appendMessage(thread.id, thread.projectRoot, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'agent',
      agentId: 'codex',
      content: 'previous codex response',
      runId: randomUUID(),
      dispatchedTo: [],
      patches: [],
      warnings: [],
    });

    // Re-read so the thread object held by TurnController has the new message.
    thread = await store.getThread(thread.id, thread.projectRoot);

    await controller.runTurn(makeParams({ input: 'continue', thread }));

    const updated = await store.getThread(thread.id, thread.projectRoot);
    const lastAgentMsg = [...updated.messages].reverse().find((m) => m.role === 'agent');

    expect(lastAgentMsg?.agentId).toBe('codex');
  });

  // -------------------------------------------------------------------------

  it('bare message falls to workerModel when no prior agent', async () => {
    // Thread has no messages yet; workerModel defaults to 'claude'.
    expect(thread.messages).toHaveLength(0);
    expect(thread.workerModel).toBe('claude');

    await controller.runTurn(makeParams({ input: 'hello' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);
    const agentMsg = updated.messages.find((m) => m.role === 'agent');

    expect(agentMsg?.agentId).toBe('claude');
  });

  // -------------------------------------------------------------------------

  it('@fixy command returns stub system message', async () => {
    await controller.runTurn(makeParams({ input: '@fixy /status' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);
    const systemMsg = updated.messages.find((m) => m.role === 'system');

    expect(systemMsg?.content).toBe('command not yet implemented');
  });

  // -------------------------------------------------------------------------

  it('unknown mention appends error system message', async () => {
    await controller.runTurn(makeParams({ input: '@unknown do stuff' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);

    const systemMsg = updated.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toBe('unknown agent: @unknown');

    const agentMsgs = updated.messages.filter((m) => m.role === 'agent');
    expect(agentMsgs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------

  it('4 mentions rejects with max adapters message', async () => {
    registry.register(createStubAdapter('aider', 'Aider'));
    registry.register(createStubAdapter('gemini', 'Gemini'));

    await controller.runTurn(makeParams({ input: '@claude @codex @aider @gemini do stuff' }));

    const updated = await store.getThread(thread.id, thread.projectRoot);

    const systemMsg = updated.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('maximum 3 adapters per turn');

    const agentMsgs = updated.messages.filter((m) => m.role === 'agent');
    expect(agentMsgs).toHaveLength(0);
  });
});
