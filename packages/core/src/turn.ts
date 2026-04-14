// packages/core/src/turn.ts

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';

import type { FixyExecutionContext, FixyExecutionResult } from './adapter.js';
import type { FixyMessage, FixyThread } from './thread.js';
import type { AdapterRegistry } from './registry.js';
import { Router } from './router.js';
import type { LocalThreadStore } from './store.js';
import { FixyCommandRunner } from './fixy-commands.js';
import { WorktreeManager } from './worktree.js';

export interface TurnResult {
  inputTokens?: number;
  outputTokens?: number;
}

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
  async runTurn(params: TurnParams): Promise<TurnResult> {
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

    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;

    const accumulate = (result: FixyExecutionResult): void => {
      if (result.inputTokens !== undefined) {
        totalInputTokens = (totalInputTokens ?? 0) + result.inputTokens;
      }
      if (result.outputTokens !== undefined) {
        totalOutputTokens = (totalOutputTokens ?? 0) + result.outputTokens;
      }
    };

    switch (parsed.kind) {
      case 'mention': {
        if (parsed.agentIds.length > 3) {
          await this._appendSystemMessage('maximum 3 adapters per turn', params);
          return {};
        }
        if (!parsed.body.trim() && parsed.fileRefs.length === 0) {
          const agents = parsed.agentIds.map((id) => `@${id}`).join(', ');
          await this._appendSystemMessage(`Usage: ${agents} <message>`, params);
          return {};
        }
        let mentionBody = parsed.body;
        if (parsed.fileRefs.length > 0) {
          const { prefix, errors } = await this._resolveFileRefs(
            parsed.fileRefs,
            thread.projectRoot,
          );
          for (const err of errors) {
            params.onLog('stderr', err + '\n');
          }
          mentionBody = prefix + mentionBody;
        }
        for (const agentId of parsed.agentIds) {
          const result = await this._dispatchToAdapter(agentId, mentionBody, params);
          accumulate(result);
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
        let bareBody = parsed.body;
        if (parsed.fileRefs.length > 0) {
          const { prefix, errors } = await this._resolveFileRefs(
            parsed.fileRefs,
            thread.projectRoot,
          );
          for (const err of errors) {
            params.onLog('stderr', err + '\n');
          }
          bareBody = prefix + bareBody;
        }
        const result = await this._dispatchToAdapter(resolvedAgentId, bareBody, params);
        accumulate(result);
        break;
      }

      case 'error': {
        await this._appendSystemMessage(parsed.reason, params);
        break;
      }
    }

    return {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  private _buildMessageList(messages: FixyMessage[]): FixyMessage[] {
    // Find the last compact point; if found, send only that message + everything after it.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.compacted === true) {
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
  ): Promise<FixyExecutionResult> {
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

    return result;
  }

  private async _resolveFileRefs(
    fileRefs: string[],
    projectRoot: string,
  ): Promise<{ prefix: string; errors: string[] }> {
    const MAX_FILE_SIZE = 100 * 1024; // 100KB
    const BLOCKED_SEGMENTS = ['node_modules', '.git'];
    const sections: string[] = [];
    const errors: string[] = [];

    for (const ref of fileRefs) {
      const normalized = normalize(ref);
      if (
        BLOCKED_SEGMENTS.some(
          (seg) => normalized.split('/').includes(seg) || normalized.split('\\').includes(seg),
        )
      ) {
        errors.push(`Blocked path: ${ref}`);
        continue;
      }

      const absPath = resolve(projectRoot, ref);
      // Ensure resolved path is within project root
      if (!absPath.startsWith(projectRoot)) {
        errors.push(`Path escapes project root: ${ref}`);
        continue;
      }

      try {
        const st = await stat(absPath);
        if (!st.isFile()) {
          errors.push(`Not a file: ${ref}`);
          continue;
        }
        if (st.size > MAX_FILE_SIZE) {
          errors.push(`File too large or binary: ${ref}`);
          continue;
        }

        const content = await readFile(absPath, 'utf8');
        // Basic binary detection: check for null bytes
        if (content.includes('\0')) {
          errors.push(`File too large or binary: ${ref}`);
          continue;
        }

        sections.push(`[Content of @${ref}]:\n${content}`);
      } catch {
        errors.push(`File not found: ${ref}`);
      }
    }

    return { prefix: sections.length > 0 ? sections.join('\n\n') + '\n\n' : '', errors };
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
