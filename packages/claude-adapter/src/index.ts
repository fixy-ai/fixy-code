// packages/claude-adapter/src/index.ts

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

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const args: string[] = ['--print'];

    if (ctx.session) {
      args.push('--resume', ctx.session.sessionId);
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
