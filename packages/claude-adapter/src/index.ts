// packages/claude-adapter/src/index.ts

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FixyAdapter,
  FixyModelInfo,
  FixyProbeResult,
  FixyExecutionContext,
  FixyExecutionResult,
} from '@fixy/core';

import {
  buildInheritedEnv,
  redactEnvForLogs,
  resolveCommand,
  runChildProcess,
} from '@fixy/adapter-utils';

import { loadSettings } from '@fixy/core';

import { parseClaudeStreamJson } from './parse.js';

class ClaudeAdapter implements FixyAdapter {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  async probe(): Promise<FixyProbeResult> {
    let resolvedCommand: string;
    try {
      resolvedCommand = await resolveCommand('claude');
    } catch {
      return {
        available: false,
        version: null,
        authStatus: 'unknown',
        detail: 'claude CLI not found in PATH',
      };
    }

    try {
      const result = await runChildProcess({
        command: resolvedCommand,
        args: ['--version'],
        cwd: process.cwd(),
        env: buildInheritedEnv(),
        timeoutMs: 10_000,
      });
      const version = result.stdout.trim() || null;
      return {
        available: true,
        version,
        authStatus: 'unknown',
        detail: null,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        version: null,
        authStatus: 'unknown',
        detail,
      };
    }
  }

  async getActiveModel(): Promise<string | null> {
    // 1. Try reading the model from ~/.claude/settings.json
    try {
      const configDir =
        process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
      const settingsPath = path.join(configDir, 'settings.json');
      const raw = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (typeof settings['model'] === 'string' && settings['model'].length > 0) {
        return settings['model'];
      }
    } catch {
      // Config not found or not parseable — fall through
    }

    // 2. Fallback: run claude --version and grep for a model name pattern
    try {
      const resolvedCommand = await resolveCommand('claude');
      const result = await runChildProcess({
        command: resolvedCommand,
        args: ['--version'],
        cwd: process.cwd(),
        env: buildInheritedEnv(),
        timeoutMs: 5_000,
      });
      const output = result.stdout + result.stderr;
      const match = /claude-[a-z0-9]+-[0-9]+(?:\.[0-9]+)?(?:-[0-9]+)?/.exec(output);
      if (match) return match[0] ?? null;
    } catch {
      // Ignore
    }

    return null;
  }

  async listModels(): Promise<FixyModelInfo[]> {
    const fallback: FixyModelInfo[] = [
      { id: 'claude-opus-4-6', description: 'Most capable — best for complex tasks' },
      { id: 'claude-sonnet-4-6', description: 'Balanced speed and intelligence' },
      { id: 'claude-haiku-4-5', description: 'Fastest and most compact' },
      { id: 'claude-sonnet-4-5', description: 'Previous gen — Sonnet 4.5' },
    ];

    // 1. Try fixy.ai dynamic model list
    try {
      const { fetchProviderModels } = await import('@fixy/core');
      const providers = await fetchProviderModels();
      const claude = providers.find((p) => p.provider === 'claude');
      if (claude && claude.models.length > 0) {
        return claude.models.map((m) => ({ id: m.id, description: m.description }));
      }
    } catch { /* fixy.ai unreachable — continue */ }

    // 2. Try Anthropic API directly
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) return fallback;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let response: Response;
      try {
        response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) return fallback;

      const json = (await response.json()) as { data: Array<{ id: string; display_name: string }> };
      const models = (json.data ?? [])
        .filter((m) => m.id.startsWith('claude-'))
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .map((m) => ({ id: m.id, description: m.display_name }));

      return models.length > 0 ? models : fallback;
    } catch {
      return fallback;
    }
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const args: string[] = ['--print', '--output-format', 'text'];

    if (ctx.session) {
      args.push('--resume', ctx.session.sessionId);
    }

    // Extra args: thread override takes priority over global setting
    const settings = await loadSettings();

    // Inject model from settings if set (extraArgs can still override via --model in the string)
    if (settings.claudeModel.trim().length > 0) {
      args.push('--model', settings.claudeModel.trim());
    }

    const extraArgsStr = ctx.adapterArgs?.['claude'] ?? settings.claudeArgs;
    if (extraArgsStr.trim().length > 0) {
      args.push(...extraArgsStr.trim().split(/\s+/));
    }

    const env = buildInheritedEnv({});
    const resolvedCommand = await resolveCommand('claude');

    ctx.onMeta({
      resolvedCommand,
      args,
      cwd: ctx.threadContext.worktreePath,
      env: redactEnvForLogs(env),
    });

    const result = await runChildProcess({
      command: resolvedCommand,
      args,
      cwd: ctx.threadContext.worktreePath,
      env,
      stdin: ctx.prompt,
      signal: ctx.signal,
      onLog: ctx.onLog,
      onSpawn: ctx.onSpawn,
    });

    const parsed = parseClaudeStreamJson(result.stdout);

    const warnings: string[] = [];
    if (result.stderr && result.stderr.trim().length > 0) {
      warnings.push(result.stderr.trim());
    }

    let errorMessage: string | null = null;
    if (result.exitCode !== 0 && !result.timedOut) {
      const stderrMsg = result.stderr.trim();
      errorMessage =
        stderrMsg.length > 0
          ? `claude exited with code ${result.exitCode}: ${stderrMsg}`
          : `claude exited with code ${result.exitCode}`;
    }

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      summary: parsed.summary,
      session: parsed.sessionId ? { sessionId: parsed.sessionId, params: {} } : null,
      patches: [],
      warnings,
      errorMessage,
    };
  }
}

export function createClaudeAdapter(): FixyAdapter {
  return new ClaudeAdapter();
}

export { parseClaudeStreamJson } from './parse.js';
