import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

import type { FixyExecutionContext } from './adapter.js';
import type { AdapterRegistry } from './registry.js';
import type { LocalThreadStore } from './store.js';
import type { FixyMessage, FixyThread } from './thread.js';
import type { WorktreeManager } from './worktree.js';
import { getThreadFile } from './paths.js';

export interface FixyCommandContext {
  thread: FixyThread;
  rest: string;
  store: LocalThreadStore;
  registry: AdapterRegistry;
  worktreeManager: WorktreeManager;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void;
  signal: AbortSignal;
}

export class FixyCommandRunner {
  async run(ctx: FixyCommandContext): Promise<void> {
    const { rest } = ctx;

    if (!rest.startsWith('/')) {
      await this._handleBare(rest, ctx);
      return;
    }

    const spaceIdx = rest.indexOf(' ');
    const command = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

    switch (command) {
      case '/worker':
        await this._handleWorker(args, ctx);
        break;
      case '/all':
        await this._handleAll(ctx);
        break;
      case '/settings':
        await this._handleSettings(ctx);
        break;
      case '/reset':
        await this._handleReset(ctx);
        break;
      case '/status':
        await this._handleStatus(ctx);
        break;
      default:
        await this._appendSystemMessage(`unknown command: ${command}`, ctx);
    }
  }

  private async _handleWorker(adapterId: string, ctx: FixyCommandContext): Promise<void> {
    ctx.registry.require(adapterId);

    const fresh = await ctx.store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    fresh.workerModel = adapterId;
    fresh.updatedAt = new Date().toISOString();

    const sysMsg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'system',
      agentId: null,
      content: `worker set to ${adapterId}`,
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
    };
    fresh.messages.push(sysMsg);

    await this._persistThread(fresh);
    ctx.thread.workerModel = adapterId;
  }

  private async _handleAll(ctx: FixyCommandContext): Promise<void> {
    await this._appendSystemMessage(
      'collaboration engine not yet implemented — arriving in Step 12',
      ctx,
    );
  }

  private async _handleSettings(ctx: FixyCommandContext): Promise<void> {
    await this._appendSystemMessage('settings command not yet implemented', ctx);
  }

  private async _handleReset(ctx: FixyCommandContext): Promise<void> {
    ctx.thread.agentSessions = {};

    for (const [agentId, worktreePath] of Object.entries(ctx.thread.worktrees)) {
      const handle = {
        path: worktreePath,
        branch: `fixy/${ctx.thread.id}-${agentId}`,
        agentId,
        threadId: ctx.thread.id,
      };
      await ctx.worktreeManager.reset(handle, ctx.thread.projectRoot);
    }

    const fresh = await ctx.store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    fresh.agentSessions = {};
    fresh.updatedAt = new Date().toISOString();
    await this._persistThread(fresh);

    await this._appendSystemMessage(
      'thread reset — all agent sessions cleared, worktrees re-provisioned',
      ctx,
    );
  }

  private async _handleStatus(ctx: FixyCommandContext): Promise<void> {
    const adapters = ctx.registry.list();
    const lines: string[] = [`worker: ${ctx.thread.workerModel}`, ''];

    for (const adapter of adapters) {
      const probe = await adapter.probe();
      const session = ctx.thread.agentSessions[adapter.id];
      const sessionId = session ? session.sessionId : 'none';

      lines.push(`adapter: ${adapter.id}`);
      lines.push(`  name: ${adapter.name}`);
      lines.push(`  available: ${probe.available ? 'yes' : 'no'}`);
      lines.push(`  version: ${probe.version ?? 'unknown'}`);
      lines.push(`  auth: ${probe.authStatus}`);
      lines.push(`  session: ${sessionId}`);
      if (probe.detail) {
        lines.push(`  detail: ${probe.detail}`);
      }
      lines.push('');
    }

    await this._appendSystemMessage(lines.join('\n').trimEnd(), ctx);
  }

  private async _handleBare(prompt: string, ctx: FixyCommandContext): Promise<void> {
    const { thread } = ctx;
    const adapter = ctx.registry.require(thread.workerModel);
    const runId = randomUUID();

    const execCtx: FixyExecutionContext = {
      runId,
      agent: { id: adapter.id, name: adapter.name },
      threadContext: {
        threadId: thread.id,
        projectRoot: thread.projectRoot,
        worktreePath: thread.projectRoot,
        repoRef: null,
      },
      messages: thread.messages,
      prompt,
      session: thread.agentSessions[thread.workerModel] ?? null,
      onLog: ctx.onLog,
      onMeta: () => {},
      onSpawn: () => {},
      signal: ctx.signal,
    };

    const result = await adapter.execute(execCtx);

    thread.agentSessions[thread.workerModel] = result.session;

    const agentMsg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'agent',
      agentId: 'fixy',
      content: result.summary,
      runId,
      dispatchedTo: [],
      patches: result.patches,
      warnings: result.warnings,
    };

    await ctx.store.appendMessage(thread.id, thread.projectRoot, agentMsg);
  }

  private async _persistThread(thread: FixyThread): Promise<void> {
    const filePath = getThreadFile(thread.projectRoot, thread.id);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(thread, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  private async _appendSystemMessage(content: string, ctx: FixyCommandContext): Promise<void> {
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
    await ctx.store.appendMessage(ctx.thread.id, ctx.thread.projectRoot, msg);
  }
}
