// packages/claude-adapter/src/index.ts

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FixyAdapter,
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

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const args: string[] = ['--print', '--output-format', 'text'];

    if (ctx.session) {
      args.push('--resume', ctx.session.sessionId);
    }

    // Extra args: thread override takes priority over global setting
    const settings = await loadSettings();
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
