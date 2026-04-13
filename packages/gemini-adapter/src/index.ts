// packages/gemini-adapter/src/index.ts

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

import { parseGeminiOutput, parseListSessions } from './parse.js';

// Gemini CLI emits a credentials notice on every invocation — suppress it.
const GEMINI_CREDENTIALS_NOISE = 'Loaded cached credentials.';

function filterGeminiNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes(GEMINI_CREDENTIALS_NOISE))
    .join('\n')
    .trim();
}

class GeminiAdapter implements FixyAdapter {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI';

  async probe(): Promise<FixyProbeResult> {
    let resolvedCommand: string;
    try {
      resolvedCommand = await resolveCommand('gemini');
    } catch {
      return {
        available: false,
        version: null,
        authStatus: 'unknown',
        detail: 'gemini CLI not found in PATH',
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
    try {
      const cmd = await resolveCommand('gemini');
      const result = await runChildProcess({
        command: cmd,
        args: ['--version'],
        cwd: process.cwd(),
        env: buildInheritedEnv(),
        timeoutMs: 5_000,
      });
      const output = (result.stdout + result.stderr).trim();
      // Match patterns like "gemini-2.0-flash", "gemini-1.5-pro", "gemini-2.5-pro", etc.
      const matched = output.match(/gemini-[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9]+)*/);
      if (matched) return matched[0].trim();
    } catch {
      // Ignore — model name is best-effort
    }
    return null;
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const resolvedCommand = await resolveCommand('gemini');
    const env = buildInheritedEnv({});

    // Extra args: thread override takes priority over global setting
    const settings = await loadSettings();
    const extraArgsStr = ctx.adapterArgs?.['gemini'] ?? settings.geminiArgs;
    const extraArgs = extraArgsStr.trim().length > 0 ? extraArgsStr.trim().split(/\s+/) : [];

    const args: string[] = ['--output-format', 'text'];

    if (ctx.session) {
      args.push('--resume', ctx.session.sessionId);
    }

    args.push(...extraArgs);
    // Prompt is the final positional argument (non-interactive mode)
    args.push(ctx.prompt);

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
      signal: ctx.signal,
      onLog: (stream, chunk) => {
        if (stream === 'stderr') {
          const filtered = filterGeminiNoise(chunk);
          if (filtered.length > 0) ctx.onLog('stderr', filtered);
          return;
        }
        // stdout: filter noise and forward plain text
        const filtered = filterGeminiNoise(chunk);
        if (filtered.length > 0) ctx.onLog('stdout', filtered);
      },
      onSpawn: ctx.onSpawn,
    });

    // Resolve the session index for the turn we just ran via --list-sessions.
    // The first line of that output holds the most-recent session index.
    let sessionIndex: string | null = null;
    try {
      const listResult = await runChildProcess({
        command: resolvedCommand,
        args: ['--list-sessions'],
        cwd: process.cwd(),
        env,
        timeoutMs: 10_000,
      });
      sessionIndex = parseListSessions(listResult.stdout);
    } catch {
      // Best-effort — session resume not critical
    }

    const parsed = parseGeminiOutput(result.stdout);

    const warnings: string[] = [];
    const filteredStderr = filterGeminiNoise(result.stderr ?? '');
    if (filteredStderr.length > 0) {
      warnings.push(filteredStderr);
    }

    let errorMessage: string | null = null;
    if (result.exitCode !== 0 && !result.timedOut) {
      errorMessage =
        filteredStderr.length > 0
          ? `gemini exited with code ${result.exitCode}: ${filteredStderr}`
          : `gemini exited with code ${result.exitCode}`;
    }

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      summary: parsed.summary,
      session: sessionIndex !== null ? { sessionId: sessionIndex, params: {} } : null,
      patches: [],
      warnings,
      errorMessage,
    };
  }
}

export function createGeminiAdapter(): FixyAdapter {
  return new GeminiAdapter();
}

export { parseGeminiOutput, parseListSessions } from './parse.js';
