// packages/gemini-adapter/src/index.ts

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
      // Try to match a gemini model name pattern first
      const modelMatch = output.match(/gemini-[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9]+)*/);
      if (modelMatch) return modelMatch[0].trim();
      // Fall back to version string (e.g. "0.17.1")
      const versionMatch = output.match(/[0-9]+\.[0-9]+\.[0-9]+/);
      if (versionMatch) return `v${versionMatch[0]}`;
    } catch {
      // Ignore — model name is best-effort
    }
    return null;
  }

  async listModels(): Promise<FixyModelInfo[]> {
    const fallback: FixyModelInfo[] = [
      { id: 'gemini-2.5-pro', description: 'Most capable Gemini model' },
      { id: 'gemini-2.0-flash', description: 'Fast and efficient' },
    ];

    // 1. Try `gemini models` CLI command (safe: uses runChildProcess with array args)
    try {
      const cmd = await resolveCommand('gemini');
      const result = await runChildProcess({
        command: cmd,
        args: ['models'],
        cwd: process.cwd(),
        env: buildInheritedEnv(),
        timeoutMs: 5_000,
      });
      const lines = (result.stdout + '\n' + result.stderr).split('\n').map((l) => l.trim());
      const cliModels = lines
        .map((l) => {
          const m = /gemini-[a-z0-9.-]+/.exec(l);
          return m ? m[0] : null;
        })
        .filter((id): id is string => id !== null);
      const unique = [...new Set(cliModels)];
      if (unique.length > 0) {
        return unique.map((id) => ({ id }));
      }
    } catch {
      // CLI not available or failed — fall through
    }

    // 2. Try REST API
    const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    if (apiKey) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        let response: Response;
        try {
          response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
            { signal: controller.signal },
          );
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          const json = (await response.json()) as {
            models: Array<{ name: string; displayName: string; description: string }>;
          };
          const apiModels = (json.models ?? [])
            .filter((m) => m.name.includes('gemini'))
            .map((m) => ({
              id: m.name.replace(/^models\//, ''),
              description: m.displayName,
            }));
          if (apiModels.length > 0) return apiModels;
        }
      } catch {
        // Fall through to fallback
      }
    }

    return fallback;
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

    // Inject model from settings if set
    if (settings.geminiModel.trim().length > 0) {
      args.push('--model', settings.geminiModel.trim());
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
