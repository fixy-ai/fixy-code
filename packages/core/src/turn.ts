// packages/core/src/turn.ts

import { randomUUID } from 'node:crypto';

import type { FixyExecutionContext } from './adapter.js';
import type { FixyMessage, FixyThread } from './thread.js';
import type { AdapterRegistry } from './registry.js';
import { Router } from './router.js';
import type { LocalThreadStore } from './store.js';
import { FixyCommandRunner } from './fixy-commands.js';
import { WorktreeManager } from './worktree.js';

export interface TurnParams {
  thread: FixyThread;
  input: string;
  registry: AdapterRegistry;
  store: LocalThreadStore;
  onLog: (stream: 'stdout' | 'stderr', chunk: string, agentId?: string) => void;
  signal: AbortSignal;
  worktreeManager?: WorktreeManager;
}

export class TurnController {
  async runTurn(params: TurnParams): Promise<void> {
    const { thread, input, store } = params;

    const router = new Router(params.registry);
    const parsed = router.parse(input);

    let dispatchedTo: string[];
    if (parsed.kind === 'mention') {
      dispatchedTo = parsed.agentIds;
    } else if (parsed.kind === 'bare') {
      const lastAgent = this._findLastAgentId(thread);
      dispatchedTo = [lastAgent ?? thread.workerModel];
    } else {
      dispatchedTo = [];
    }

    const userMsg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'user',
      agentId: null,
      content: input,
      runId: null,
      dispatchedTo,
      patches: [],
      warnings: [],
    };

    await store.appendMessage(thread.id, thread.projectRoot, userMsg);

    switch (parsed.kind) {
      case 'mention': {
        if (parsed.agentIds.length > 3) {
          await this._appendSystemMessage('maximum 3 adapters per turn', params);
          return;
        }
        for (const agentId of parsed.agentIds) {
          await this._dispatchToAdapter(agentId, parsed.body, params);
        }
        break;
      }

      case 'fixy': {
        const runner = new FixyCommandRunner();
        await runner.run({
          thread: params.thread,
          rest: parsed.rest,
          store: params.store,
          registry: params.registry,
          worktreeManager: params.worktreeManager ?? new WorktreeManager(),
          onLog: params.onLog,
          signal: params.signal,
        });
        break;
      }

      case 'bare': {
        const lastAgent = this._findLastAgentId(thread);
        const resolvedAgentId = lastAgent ?? thread.workerModel;
        await this._dispatchToAdapter(resolvedAgentId, parsed.body, params);
        break;
      }

      case 'error': {
        await this._appendSystemMessage(parsed.reason, params);
        break;
      }
    }
  }

  private _buildMessageList(messages: FixyMessage[]): FixyMessage[] {
    // Find the last compact point; if found, send only that message + everything after it.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.compacted === true) {
        return messages.slice(i);
      }
    }
    return messages;
  }

  private _findLastAgentId(thread: FixyThread): string | null {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const msg = thread.messages[i];
      if (msg.role === 'agent' && msg.agentId !== null) {
        return msg.agentId;
      }
    }
    return null;
  }

  private async _dispatchToAdapter(
    agentId: string,
    body: string,
    params: TurnParams,
  ): Promise<void> {
    const freshThread = await params.store.getThread(params.thread.id, params.thread.projectRoot);

    const adapter = params.registry.require(agentId);
    const runId = randomUUID();

    const ctx: FixyExecutionContext = {
      runId,
      agent: { id: adapter.id, name: adapter.name },
      threadContext: {
        threadId: freshThread.id,
        projectRoot: freshThread.projectRoot,
        worktreePath: freshThread.projectRoot,
        repoRef: null,
      },
      messages: this._buildMessageList(freshThread.messages),
      prompt: body,
      session: freshThread.agentSessions[agentId] ?? null,
      adapterArgs: freshThread.adapterArgs,
      onLog: (stream, chunk) => params.onLog(stream, chunk, agentId),
      onMeta: () => {},
      onSpawn: () => {},
      signal: params.signal,
    };

    const result = await adapter.execute(ctx);

    const agentMsg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'agent',
      agentId: adapter.id,
      content: result.summary,
      runId,
      dispatchedTo: [],
      patches: result.patches,
      warnings: result.warnings,
    };

    await params.store.appendMessage(params.thread.id, params.thread.projectRoot, agentMsg);

    params.thread.agentSessions[agentId] = result.session;
  }

  private async _appendSystemMessage(content: string, params: TurnParams): Promise<void> {
    const msg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'system',
      agentId: null,
      content,
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    await params.store.appendMessage(params.thread.id, params.thread.projectRoot, msg);
  }
}
