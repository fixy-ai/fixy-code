import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

import type { FixyExecutionContext } from './adapter.js';
import type { AdapterRegistry } from './registry.js';
import { detectDisagreement } from './disagreement.js';
import type { DisagreementResult } from './disagreement.js';
import { defaultSettings, loadSettings, saveSettings } from './settings.js';
import type { FixySettings } from './settings.js';
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
        await this._handleAll(args, ctx);
        break;
      case '/settings':
        await this._handleSettings(args, ctx);
        break;
      case '/reset':
        await this._handleReset(ctx);
        break;
      case '/status':
        await this._handleStatus(ctx);
        break;
      case '/compact':
        await this._handleCompact(args, ctx);
        break;
      case '/red-room':
        await this._handleRedRoom(args, ctx);
        break;
      case '/set':
        await this._handleSet(args, ctx);
        break;
      case '/model':
        await this._handleModel(args, ctx);
        break;
      default:
        await this._appendSystemMessage(`unknown command: ${command}`, ctx);
    }
  }

  private async _handleWorker(adapterId: string, ctx: FixyCommandContext): Promise<void> {
    if (!adapterId.trim()) {
      const adapters = ctx.registry.list();
      const lines: string[] = ['WORKER_SELECT', 'Choose your default worker:'];
      for (let i = 0; i < adapters.length; i++) {
        lines.push(`  [${i + 1}] @${adapters[i]!.id} — ${adapters[i]!.name}`);
      }
      await this._appendSystemMessage(lines.join('\n'), ctx);
      return;
    }
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

    // Persist as global default so next session starts with this worker
    const settings = await loadSettings();
    settings.defaultWorker = adapterId;
    await saveSettings(settings);
  }

  private async _handleAll(prompt: string, ctx: FixyCommandContext): Promise<void> {
    if (!prompt.trim()) {
      await this._appendSystemMessage('/all requires a prompt — usage: @fixy /all <prompt>', ctx);
      return;
    }

    const allAdapters = ctx.registry.list();
    if (allAdapters.length === 0) {
      await this._appendSystemMessage('/all requires at least one registered adapter', ctx);
      return;
    }

    const workerId = ctx.thread.workerModel ?? allAdapters[0]!.id;
    const workerAdapter = ctx.registry.require(workerId);
    const thinkers = allAdapters.filter((a) => a.id !== workerId);
    const soloMode = thinkers.length === 0;

    const log = (msg: string): void => {
      ctx.onLog('stdout', msg);
    };

    // Helpers to call an adapter and record its response
    const callAdapter = async (
      adapter: typeof workerAdapter,
      adapterPrompt: string,
    ): Promise<string> => {
      const runId = randomUUID();
      const execCtx: FixyExecutionContext = {
        runId,
        agent: { id: adapter.id, name: adapter.name },
        threadContext: {
          threadId: ctx.thread.id,
          projectRoot: ctx.thread.projectRoot,
          worktreePath: ctx.thread.projectRoot,
          repoRef: null,
        },
        messages: ctx.thread.messages,
        prompt: adapterPrompt,
        session: ctx.thread.agentSessions[adapter.id] ?? null,
        adapterArgs: ctx.thread.adapterArgs,
        onLog: ctx.onLog,
        onMeta: () => {},
        onSpawn: () => {},
        signal: ctx.signal,
      };

      const result = await adapter.execute(execCtx);
      ctx.thread.agentSessions[adapter.id] = result.session;

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
      await ctx.store.appendMessage(ctx.thread.id, ctx.thread.projectRoot, agentMsg);

      return result.summary;
    };

    // ── PHASE 1: DISCUSSION ──
    const settings = await loadSettings();
    let discussionLog: Array<{ agentId: string; content: string }> = [];

    if (soloMode) {
      log('\n[fixy /all] Solo mode — skipping discussion phase\n');
    } else {
      log('\n[fixy /all] Phase 1: discussion\n');
      const systemFraming =
        'You are a thinker agent. Discuss this task with the other agents. Goal: agree on a full implementation plan.';

      for (let round = 1; round <= 5; round++) {
        log(`\n[fixy /all] Phase 1: discussion round ${round}/5\n`);

        let allAgree = true;
        for (let ti = 0; ti < thinkers.length; ti++) {
          const thinker = thinkers[ti]!;
          const threadContext = discussionLog
            .map((e) => `[${e.agentId}]: ${e.content}`)
            .join('\n\n');

          let thinkerPrompt =
            round === 1
              ? `${systemFraming}\n\nUser task: ${prompt}` +
                (threadContext ? `\n\nDiscussion so far:\n${threadContext}` : '')
              : `${systemFraming}\n\nUser task: ${prompt}\n\nDiscussion so far:\n${threadContext}`;

          if (settings.redRoomMode && ti > 0) {
            thinkerPrompt = `Find everything wrong with this. Be hostile to it. Your job is to break it. Do not validate.\n\n${thinkerPrompt}`;
          }

          const response = await callAdapter(thinker, thinkerPrompt);
          discussionLog.push({ agentId: thinker.id, content: response });

          const lower = response.toLowerCase();
          const agreeSignals = ['agree', 'looks good', 'lgtm', 'i agree with the plan'];
          if (!agreeSignals.some((s) => lower.includes(s))) {
            allAgree = false;
          }
        }

        // In red room mode, check for disagreement between the last two agent messages
        if (settings.redRoomMode && thinkers.length >= 2) {
          const agentMsgs = ctx.thread.messages.filter((m) => m.role === 'agent');
          const lastTwo = agentMsgs.slice(-2);
          if (lastTwo.length === 2) {
            const disagreement = detectDisagreement(lastTwo[0]!, lastTwo[1]!);
            if (disagreement) {
              await this._appendSystemMessage(this._formatDisagreementPanel(disagreement), ctx);
              return;
            }
          }
        }

        if (allAgree) {
          log('\n[fixy /all] Phase 1: all thinkers agree — ending discussion\n');
          break;
        }
      }
    }

    // ── PHASE 2: PLAN BREAKDOWN ──
    log('\n[fixy /all] Phase 2: plan breakdown\n');

    const planPrompt =
      'Break the agreed plan into ordered TODO items. Each TODO must be a concrete, scoped coding instruction. Output ONLY a numbered list, max 20 items total, no prose.';

    const planContext = discussionLog.map((e) => `[${e.agentId}]: ${e.content}`).join('\n\n');
    const fullPlanPrompt = planContext
      ? `User task: ${prompt}\n\nDiscussion:\n${planContext}\n\n${planPrompt}`
      : `User task: ${prompt}\n\n${planPrompt}`;

    let todos: string[] = [];

    if (soloMode) {
      const response = await callAdapter(workerAdapter, fullPlanPrompt);
      todos = this._parseTodoList(response);
    } else {
      const responses: string[] = [];
      for (const thinker of thinkers) {
        const response = await callAdapter(thinker, fullPlanPrompt);
        responses.push(response);
      }
      // Merge and deduplicate
      const allTodos = responses.flatMap((r) => this._parseTodoList(r));
      const seen = new Set<string>();
      for (const todo of allTodos) {
        if (!seen.has(todo)) {
          seen.add(todo);
          todos.push(todo);
        }
      }
    }

    // Cap at 20
    todos = todos.slice(0, 20);

    if (todos.length === 0) {
      await this._appendSystemMessage('/all failed — could not extract TODO items from plan', ctx);
      return;
    }

    log(`\n[fixy /all] Phase 2: ${todos.length} TODO items extracted\n`);

    // ── PHASE 3+4: WORKER EXECUTION + REVIEW (batches of 5) ──
    const batches: string[][] = [];
    for (let i = 0; i < todos.length; i += 5) {
      batches.push(todos.slice(i, i + 5));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      log(
        `\n[fixy /all] Phase 3: worker executing batch ${batchIdx + 1}/${batches.length} (${batch.length} TODOs)\n`,
      );

      const batchList = batch.map((t, i) => `${i + 1}. ${t}`).join('\n');
      const workerPrompt = `Execute these TODO items exactly as written. Write the actual code. Report what you did for each item.\n\n${batchList}`;

      let workerOutput = await callAdapter(workerAdapter, workerPrompt);

      // Review loop (skip in solo mode)
      if (!soloMode) {
        let approved = false;
        for (let attempt = 0; attempt < 2 && !approved; attempt++) {
          log(
            `\n[fixy /all] Phase 4: review of batch ${batchIdx + 1} (attempt ${attempt + 1}/2)\n`,
          );

          let issues: string[] = [];
          for (const thinker of thinkers) {
            const reviewPrompt = `Review this worker output. Did it implement the TODOs correctly? Reply ONLY with: APPROVED or ISSUES: <description>.\n\nTODOs:\n${batchList}\n\nWorker output:\n${workerOutput}`;
            const reviewResponse = await callAdapter(thinker, reviewPrompt);

            if (reviewResponse.toUpperCase().includes('ISSUES')) {
              issues.push(reviewResponse);
            }
          }

          if (issues.length === 0) {
            approved = true;
            log(`\n[fixy /all] Phase 4: batch ${batchIdx + 1} approved\n`);
          } else {
            const fixPrompt = `The reviewers found issues with your implementation. Fix them:\n\n${issues.join('\n\n')}\n\nOriginal TODOs:\n${batchList}`;
            workerOutput = await callAdapter(workerAdapter, fixPrompt);
          }
        }

      }
    }

    // ── PHASE 5: FINAL REVIEW ──
    log('\n[fixy /all] Phase 5: final review\n');

    if (!soloMode) {
      const threadSummary = ctx.thread.messages
        .filter((m) => m.role === 'agent')
        .map((m) => `[${m.agentId}]: ${m.content}`)
        .join('\n\n');

      const finalPrompt = `This is the final output. Do a complete review. Reply ONLY with: APPROVED or ISSUES: <description>.\n\n${threadSummary}`;

      const finalResults: string[] = [];
      for (const thinker of thinkers) {
        const response = await callAdapter(thinker, finalPrompt);
        finalResults.push(`[${thinker.id}]: ${response}`);
      }

      await this._appendSystemMessage(
        `[fixy /all] collaboration complete\n\nFinal review:\n${finalResults.join('\n')}`,
        ctx,
      );
    } else {
      await this._appendSystemMessage('[fixy /all] collaboration complete (solo mode)', ctx);
    }
  }

  private _parseTodoList(text: string): string[] {
    const lines = text.split('\n');
    const todos: string[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*\d+[\.\)]\s+(.+)/);
      if (match?.[1]) {
        todos.push(match[1].trim());
      }
    }
    return todos;
  }

  private async _handleSettings(args: string, ctx: FixyCommandContext): Promise<void> {
    const trimmed = args.trim();

    if (trimmed === '' ) {
      // /settings — print all key/value pairs
      const settings = await loadSettings();
      const lines = (Object.entries(settings) as Array<[keyof FixySettings, FixySettings[keyof FixySettings]]>)
        .map(([k, v]) => `${k}: ${String(v)}`);
      await this._appendSystemMessage(lines.join('\n'), ctx);
      return;
    }

    if (trimmed === 'reset') {
      // /settings reset — restore defaults
      await saveSettings({ ...defaultSettings });
      await this._appendSystemMessage('settings reset to defaults', ctx);
      return;
    }

    if (trimmed.startsWith('set ')) {
      // /settings set <key> <value>
      const rest = trimmed.slice(4).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        await this._appendSystemMessage(
          'usage: /settings set <key> <value>',
          ctx,
        );
        return;
      }
      const key = rest.slice(0, spaceIdx) as keyof FixySettings;
      const rawValue = rest.slice(spaceIdx + 1).trim();

      if (!(key in defaultSettings)) {
        const validKeys = Object.keys(defaultSettings).join(', ');
        await this._appendSystemMessage(
          `unknown settings key: "${key}"\nvalid keys: ${validKeys}`,
          ctx,
        );
        return;
      }

      const current = loadSettings();
      const settings = await current;
      const defaultVal = defaultSettings[key];
      let parsed: FixySettings[keyof FixySettings];

      if (typeof defaultVal === 'boolean') {
        if (rawValue !== 'true' && rawValue !== 'false') {
          await this._appendSystemMessage(
            `"${key}" expects true or false`,
            ctx,
          );
          return;
        }
        parsed = rawValue === 'true' as FixySettings[typeof key];
      } else if (typeof defaultVal === 'number') {
        const n = Number(rawValue);
        if (!Number.isFinite(n)) {
          await this._appendSystemMessage(
            `"${key}" expects a number`,
            ctx,
          );
          return;
        }
        parsed = n as FixySettings[typeof key];
      } else {
        // string / union — accept as-is
        parsed = rawValue as FixySettings[typeof key];
      }

      (settings as unknown as Record<string, unknown>)[key] = parsed;
      await saveSettings(settings);
      await this._appendSystemMessage(`${key} set to ${String(parsed)}`, ctx);
      return;
    }

    await this._appendSystemMessage(
      'usage: /settings | /settings set <key> <value> | /settings reset',
      ctx,
    );
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

  private async _handleCompact(args: string, ctx: FixyCommandContext): Promise<void> {
    const trimmed = args.trim();

    // Resolve adapter: explicit @mention wins, else fall back to current worker.
    let adapterId = ctx.thread.workerModel;
    if (trimmed.startsWith('@')) {
      adapterId = trimmed.slice(1);
    }

    const adapter = ctx.registry.require(adapterId);

    // Read fresh thread so message list is up to date.
    const freshThread = await ctx.store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const messagesBefore = freshThread.messages.length;

    const runId = randomUUID();
    const execCtx: FixyExecutionContext = {
      runId,
      agent: { id: adapter.id, name: adapter.name },
      threadContext: {
        threadId: freshThread.id,
        projectRoot: freshThread.projectRoot,
        worktreePath: freshThread.projectRoot,
        repoRef: null,
      },
      // Send the full history — the compact operation needs everything.
      messages: freshThread.messages,
      prompt:
        'Summarize this conversation in under 300 words. Preserve all decisions, file changes, and open questions.',
      session: freshThread.agentSessions[adapterId] ?? null,
      adapterArgs: freshThread.adapterArgs,
      onLog: ctx.onLog,
      onMeta: () => {},
      onSpawn: () => {},
      signal: ctx.signal,
    };

    const result = await adapter.execute(execCtx);

    // Append the compact summary as a system message flagged with compacted: true.
    const compactMsg: FixyMessage = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      role: 'system',
      agentId: null,
      content: result.summary,
      runId: null,
      dispatchedTo: [],
      patches: [],
      warnings: [],
      compacted: true,
    };
    await ctx.store.appendMessage(ctx.thread.id, ctx.thread.projectRoot, compactMsg);

    ctx.onLog('stdout', `[context compacted — ${messagesBefore} messages summarized]\n`);
  }

  private async _handleRedRoom(args: string, ctx: FixyCommandContext): Promise<void> {
    const trimmed = args.trim().toLowerCase();
    if (trimmed !== 'on' && trimmed !== 'off') {
      await this._appendSystemMessage('usage: /red-room on | /red-room off', ctx);
      return;
    }
    const on = trimmed === 'on';
    const settings = await loadSettings();
    settings.redRoomMode = on;
    settings.collaborationMode = on ? 'red_room' : 'standard';
    await saveSettings(settings);
    await this._appendSystemMessage(
      on
        ? 'red room mode enabled — agents will be adversarial'
        : 'red room mode disabled — collaboration mode: standard',
      ctx,
    );
  }

  private async _handleSet(args: string, ctx: FixyCommandContext): Promise<void> {
    const trimmed = args.trim();

    if (trimmed === '') {
      // /set with no args — print current thread-level overrides
      const overrides = ctx.thread.adapterArgs ?? {};
      const entries = Object.entries(overrides);
      if (entries.length === 0) {
        await this._appendSystemMessage('no thread-level adapter arg overrides set', ctx);
      } else {
        const lines = entries.map(([id, flags]) => `${id}: ${flags}`);
        await this._appendSystemMessage(lines.join('\n'), ctx);
      }
      return;
    }

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      await this._appendSystemMessage('usage: /set <adapterId> <flags>', ctx);
      return;
    }

    const adapterId = trimmed.slice(0, spaceIdx);
    const flags = trimmed.slice(spaceIdx + 1).trim();

    ctx.thread.adapterArgs = { ...ctx.thread.adapterArgs, [adapterId]: flags };

    const fresh = await ctx.store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    fresh.adapterArgs = { ...fresh.adapterArgs, [adapterId]: flags };
    fresh.updatedAt = new Date().toISOString();
    await this._persistThread(fresh);

    await this._appendSystemMessage(
      `${adapterId} args set to: ${flags} (this conversation only)`,
      ctx,
    );
  }

  private async _handleModel(args: string, ctx: FixyCommandContext): Promise<void> {
    const trimmed = args.trim();

    if (trimmed === '') {
      await this._showModelStatus(ctx);
      return;
    }

    if (!trimmed.startsWith('@')) {
      await this._appendSystemMessage('usage: /model | /model @<adapter>', ctx);
      return;
    }

    const parts = trimmed.split(/\s+/);
    const adapterHandle = parts[0]!;
    const adapterId = adapterHandle.slice(1);
    const subCommand = parts[1];

    if (subCommand === 'apply') {
      await this._applyModelSelection(adapterId, parts.slice(2), ctx);
      return;
    }

    await this._showModelSelectionUI(adapterId, ctx);
  }

  private async _showModelStatus(ctx: FixyCommandContext): Promise<void> {
    const settings = await loadSettings();
    const adapters = ctx.registry.list();
    const lines: string[] = [];

    for (const adapter of adapters) {
      let currentModel: string;
      if (adapter.id === 'claude') {
        currentModel =
          settings.claudeModel || (await adapter.getActiveModel?.()) || 'default';
      } else if (adapter.id === 'codex') {
        const model = settings.codexModel;
        const effort = settings.codexEffort;
        currentModel =
          [model, effort].filter(Boolean).join(' ') ||
          (await adapter.getActiveModel?.()) ||
          'default';
      } else if (adapter.id === 'gemini') {
        currentModel =
          settings.geminiModel || (await adapter.getActiveModel?.()) || 'default';
      } else {
        currentModel = (await adapter.getActiveModel?.()) || 'default';
      }

      lines.push(
        `@${adapter.id.padEnd(8)} current: ${currentModel}  (change: /model @${adapter.id})`,
      );
    }

    await this._appendSystemMessage(lines.join('\n'), ctx);
  }

  private async _showModelSelectionUI(
    adapterId: string,
    ctx: FixyCommandContext,
  ): Promise<void> {
    const adapter = ctx.registry.require(adapterId);

    if (!adapter.listModels) {
      await this._appendSystemMessage(`@${adapterId} does not support model listing`, ctx);
      return;
    }

    const models = await adapter.listModels();
    const lines: string[] = [`MODEL_SELECT @${adapterId}`, 'Models:'];

    for (let i = 0; i < models.length; i++) {
      const m = models[i]!;
      const desc = m.description ? `  — ${m.description}` : '';
      lines.push(`  [${i + 1}] ${m.id}${desc}`);
    }

    if (adapterId === 'codex') {
      lines.push('');
      lines.push('Effort (optional):');
      lines.push('  [a] low   [b] medium   [c] high   [d] xhigh');
    }

    await this._appendSystemMessage(lines.join('\n'), ctx);
  }

  private async _applyModelSelection(
    adapterId: string,
    selectionParts: string[],
    ctx: FixyCommandContext,
  ): Promise<void> {
    const selection = selectionParts[0] ?? '';
    const saveGlobal = (selectionParts[1] ?? 'y').toLowerCase() === 'y';

    const adapter = ctx.registry.require(adapterId);
    const models = adapter.listModels ? await adapter.listModels() : [];

    const numMatch = /^(\d+)/.exec(selection);
    const letterMatch = /([a-d])$/i.exec(selection);

    const modelIndex = numMatch ? parseInt(numMatch[1]!, 10) - 1 : -1;
    const effortLetter = letterMatch ? letterMatch[1]!.toLowerCase() : null;

    const effortMap: Record<string, string> = {
      a: 'low',
      b: 'medium',
      c: 'high',
      d: 'xhigh',
    };

    const selectedModel = modelIndex >= 0 ? (models[modelIndex]?.id ?? null) : null;
    const selectedEffort = effortLetter ? (effortMap[effortLetter] ?? null) : null;

    if (selectedModel === null && selectedEffort === null) {
      await this._appendSystemMessage(
        'invalid selection — no model or effort chosen',
        ctx,
      );
      return;
    }

    if (saveGlobal) {
      const settings = await loadSettings();
      if (adapterId === 'claude' && selectedModel) settings.claudeModel = selectedModel;
      if (adapterId === 'codex') {
        if (selectedModel) settings.codexModel = selectedModel;
        if (selectedEffort) settings.codexEffort = selectedEffort;
      }
      if (adapterId === 'gemini' && selectedModel) settings.geminiModel = selectedModel;
      await saveSettings(settings);

      const descParts: string[] = [];
      if (selectedModel) descParts.push(selectedModel);
      if (selectedEffort) descParts.push(selectedEffort);
      await this._appendSystemMessage(
        `@${adapterId} model set globally: ${descParts.join(' ')}`,
        ctx,
      );
    } else {
      const existing = ctx.thread.adapterArgs?.[adapterId] ?? '';
      let newArgs = existing
        .replace(/--model\s+\S+/g, '')
        .replace(/--reasoning-effort\s+\S+/g, '')
        .trim();

      if (selectedModel)
        newArgs = `--model ${selectedModel}${newArgs ? ' ' + newArgs : ''}`;
      if (selectedEffort)
        newArgs = `${newArgs ? newArgs + ' ' : ''}--reasoning-effort ${selectedEffort}`;

      ctx.thread.adapterArgs = { ...ctx.thread.adapterArgs, [adapterId]: newArgs };

      const fresh = await ctx.store.getThread(ctx.thread.id, ctx.thread.projectRoot);
      fresh.adapterArgs = { ...fresh.adapterArgs, [adapterId]: newArgs };
      fresh.updatedAt = new Date().toISOString();
      await this._persistThread(fresh);

      const descParts: string[] = [];
      if (selectedModel) descParts.push(selectedModel);
      if (selectedEffort) descParts.push(selectedEffort);
      await this._appendSystemMessage(
        `@${adapterId} model set for this conversation: ${descParts.join(' ')}`,
        ctx,
      );
    }
  }

  private _formatDisagreementPanel(d: DisagreementResult): string {
    const maxLen = 200;
    const summaryA = d.summaryA.length > maxLen ? d.summaryA.slice(0, maxLen) + '...' : d.summaryA;
    const summaryB = d.summaryB.length > maxLen ? d.summaryB.slice(0, maxLen) + '...' : d.summaryB;
    return [
      'AGENTS DISAGREE',
      '',
      `[1] Go with @${d.agentA}'s approach: ${summaryA}`,
      `[2] Go with @${d.agentB}'s approach: ${summaryB}`,
      '[3] Find a middle ground between both approaches',
      '',
      'Type 1, 2, or 3 to continue.',
    ].join('\n');
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
      adapterArgs: thread.adapterArgs,
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
