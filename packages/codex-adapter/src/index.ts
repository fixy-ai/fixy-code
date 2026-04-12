// packages/codex-adapter/src/index.ts

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

import { parseCodexStreamJson } from './parse.js';

// Codex CLI writes skill-loader errors and stdin warnings to stderr on startup — suppress them.
const CODEX_NOISE_RE = /^[0-9TZ:.+-]+ (ERROR|WARN) codex_/;
const CODEX_STDIN_WARNING = 'warning: Reading additional input from stdin';

function filterCodexNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !CODEX_NOISE_RE.test(line) && !line.includes(CODEX_STDIN_WARNING))
    .join('\n')
    .trim();
}

class CodexAdapter implements FixyAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';

  async probe(): Promise<FixyProbeResult> {
    let resolvedCommand: string;
    try {
      resolvedCommand = await resolveCommand('codex');
    } catch {
      return {
        available: false,
        version: null,
        authStatus: 'unknown',
        detail: 'codex CLI not found in PATH',
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
      const cmd = await resolveCommand('codex');
      const result = await runChildProcess({
        command: cmd,
        args: ['--version'],
        cwd: process.cwd(),
        env: buildInheritedEnv(),
        timeoutMs: 5_000,
      });
      const output = (result.stdout + result.stderr).trim();
      // Match patterns like "gpt-4o", "gpt-4.5", "gpt-5.4 xhigh", "gpt-4o-mini"
      const match = /gpt-[0-9]+(?:\.[0-9]+)?(?:[a-z0-9-]*)(?:\s+[a-z]+)?/.exec(output);
      if (match) return match[0].trim();
    } catch {
      // Ignore
    }
    return null;
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const resolvedCommand = await resolveCommand('codex');
    const env = buildInheritedEnv({});

    let args: string[];

    if (ctx.session) {
      // Resume existing session: codex exec resume <thread_id> --json ...
      args = [
        'exec',
        'resume',
        ctx.session.sessionId,
        '--json',
        '--skip-git-repo-check',
        '--full-auto',
        ctx.prompt,
      ];
    } else {
      // New session: codex exec --json --skip-git-repo-check --full-auto <prompt>
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--full-auto',
        ctx.prompt,
      ];
    }

    ctx.onMeta({
      resolvedCommand,
      args,
      cwd: ctx.threadContext.worktreePath,
      env: redactEnvForLogs(env),
    });

    // Buffer partial stdout lines so we can parse JSONL events and forward
    // only the agent text instead of raw JSON to the terminal.
    let stdoutLineBuffer = '';

    const forwardJsonLine = (line: string): void => {
      try {
        const obj = JSON.parse(line);
        if (
          typeof obj === 'object' &&
          obj !== null &&
          obj['type'] === 'item.completed'
        ) {
          const item = obj['item'];
          if (
            typeof item === 'object' &&
            item !== null &&
            item['type'] === 'agent_message'
          ) {
            const text = item['text'];
            if (typeof text === 'string' && text.length > 0) {
              ctx.onLog('stdout', text + '\n');
            }
          }
        }
      } catch {
        // Not JSON — forward as-is (shouldn't happen with --json flag)
        if (line.length > 0) ctx.onLog('stdout', line + '\n');
      }
    };

    const result = await runChildProcess({
      command: resolvedCommand,
      args,
      cwd: ctx.threadContext.worktreePath,
      env,
      signal: ctx.signal,
      onLog: (stream, chunk) => {
        if (stream === 'stderr') {
          const filtered = filterCodexNoise(chunk);
          if (filtered.length > 0) ctx.onLog('stderr', filtered);
          return;
        }
        // stdout: buffer and parse JSONL line-by-line
        stdoutLineBuffer += chunk;
        const lines = stdoutLineBuffer.split('\n');
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) forwardJsonLine(trimmed);
        }
      },
      onSpawn: ctx.onSpawn,
    });

    // Flush any remaining buffered line
    if (stdoutLineBuffer.trim().length > 0) {
      forwardJsonLine(stdoutLineBuffer.trim());
    }

    const parsed = parseCodexStreamJson(result.stdout);

    const warnings: string[] = [];
    const filteredStderr = filterCodexNoise(result.stderr ?? '');
    if (filteredStderr.length > 0) {
      warnings.push(filteredStderr);
    }

    let errorMessage: string | null = null;
    if (result.exitCode !== 0 && !result.timedOut) {
      const stderrMsg = filteredStderr;
      errorMessage =
        stderrMsg.length > 0
          ? `codex exited with code ${result.exitCode}: ${stderrMsg}`
          : `codex exited with code ${result.exitCode}`;
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

export function createCodexAdapter(): FixyAdapter {
  return new CodexAdapter();
}

export { parseCodexStreamJson } from './parse.js';
