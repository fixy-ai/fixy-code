// packages/codex-adapter/src/index.ts

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
    // Read model from ~/.codex/config.toml (e.g. model = "gpt-5.4")
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      const raw = await fs.readFile(configPath, 'utf8');
      const modelMatch = /^model\s*=\s*"([^"]+)"/m.exec(raw);
      const effortMatch = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(raw);
      if (modelMatch) {
        const model = modelMatch[1] ?? '';
        const effort = effortMatch ? ` ${effortMatch[1]}` : '';
        return `${model}${effort}`;
      }
    } catch {
      // Config not found — fall through
    }
    return null;
  }

  async listModels(): Promise<FixyModelInfo[]> {
    const fallback: FixyModelInfo[] = [
      { id: 'gpt-4o' },
      { id: 'gpt-4o-mini' },
    ];

    const apiKey = process.env['OPENAI_API_KEY'];
    let models: FixyModelInfo[] = fallback;

    if (apiKey) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        let response: Response;
        try {
          response = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          const json = (await response.json()) as { data: Array<{ id: string }> };
          const fetched = (json.data ?? [])
            .filter(
              (m) =>
                m.id.startsWith('gpt-') ||
                m.id.startsWith('o1') ||
                m.id.startsWith('o3') ||
                m.id.startsWith('o4'),
            )
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .map((m) => ({ id: m.id }));

          if (fetched.length > 0) models = fetched;
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Prepend current model from config if not already in list
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      const raw = await fs.readFile(configPath, 'utf8');
      const modelMatch = /^model\s*=\s*"([^"]+)"/m.exec(raw);
      if (modelMatch) {
        const currentModel = modelMatch[1] ?? '';
        if (!models.some((m) => m.id === currentModel)) {
          models = [{ id: currentModel }, ...models];
        }
      }
    } catch {
      // Config not found — use list as-is
    }

    return models;
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const resolvedCommand = await resolveCommand('codex');
    const env = buildInheritedEnv({});

    // Extra args: thread override takes priority over global setting
    const settings = await loadSettings();
    const extraArgsStr = ctx.adapterArgs?.['codex'] ?? settings.codexArgs;
    const extraArgs = extraArgsStr.trim().length > 0 ? extraArgsStr.trim().split(/\s+/) : [];

    // Inject model/effort from settings if set
    const modelArgs: string[] = [];
    if (settings.codexModel.trim().length > 0) {
      modelArgs.push('--model', settings.codexModel.trim());
    }
    if (settings.codexEffort.trim().length > 0) {
      modelArgs.push('--reasoning-effort', settings.codexEffort.trim());
    }

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
        ...modelArgs,
        ...extraArgs,
        ctx.prompt,
      ];
    } else {
      // New session: codex exec --json --skip-git-repo-check --full-auto <prompt>
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--full-auto',
        ...modelArgs,
        ...extraArgs,
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
