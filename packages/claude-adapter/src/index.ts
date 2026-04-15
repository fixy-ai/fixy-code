// packages/claude-adapter/src/index.ts

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterEvent,
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
      const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
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
    // 1. Try fixy.ai dynamic model list (curated, always current)
    try {
      const { fetchProviderModels } = await import('@fixy/core');
      const providers = await fetchProviderModels();
      const claude = providers.find((p) => p.provider === 'claude');
      if (claude && claude.models.length > 0) {
        return claude.models.map((m) => ({ id: m.id, description: m.description }));
      }
    } catch {
      /* fixy.ai unreachable — continue */
    }

    // 2. Try Anthropic API directly
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey) {
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

        if (response.ok) {
          const json = (await response.json()) as {
            data: Array<{ id: string; display_name: string }>;
          };
          const models = (json.data ?? [])
            .filter((m) => m.id.startsWith('claude-'))
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .map((m) => ({ id: m.id, description: m.display_name }));
          if (models.length > 0) return models;
        }
      } catch {
        /* API failed — continue */
      }
    }

    // 3. Read current model from Claude config + known aliases
    const current = await this.getActiveModel();
    return [
      { id: 'opus', description: 'Alias for latest Opus' },
      { id: 'sonnet', description: 'Alias for latest Sonnet' },
      { id: 'haiku', description: 'Alias for latest Haiku' },
      ...(current ? [{ id: current, description: 'Currently active' }] : []),
    ];
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];

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

    // Buffer partial stdout lines for JSONL parsing
    let stdoutLineBuffer = '';
    // Track tool_id → tool_name for correlating tool_result events
    const toolNames = new Map<string, string>();

    const forwardJsonLine = (line: string): void => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const type = obj['type'] as string | undefined;

        if (type === 'message' && obj['role'] === 'assistant') {
          const content = typeof obj['content'] === 'string' ? obj['content'] : '';
          if (content.length > 0) {
            // Determine if this is thinking or content based on context
            // stream-json emits thinking via a separate "thinking" subtype or content_block
            const subtype = obj['subtype'] as string | undefined;
            if (subtype === 'thinking') {
              ctx.onEvent?.({ type: 'thinking', text: content });
            } else {
              ctx.onLog('stdout', content);
              ctx.onEvent?.({ type: 'content', text: content });
            }
          }
        } else if (type === 'content_block_delta') {
          // Streaming delta — check if it's thinking or text
          const delta = obj['delta'] as Record<string, unknown> | undefined;
          if (delta) {
            const deltaType = delta['type'] as string | undefined;
            const text = (delta['text'] ?? delta['thinking'] ?? '') as string;
            if (text.length > 0) {
              if (deltaType === 'thinking_delta') {
                ctx.onEvent?.({ type: 'thinking', text });
              } else {
                ctx.onLog('stdout', text);
                ctx.onEvent?.({ type: 'content', text });
              }
            }
          }
        } else if (type === 'tool_use') {
          const toolName = (obj['tool_name'] ?? obj['name'] ?? 'unknown') as string;
          const toolId = (obj['tool_id'] ?? obj['id'] ?? '') as string;
          const params = obj['parameters'] as Record<string, unknown> | undefined;
          const filePath = (params?.['file_path'] ?? params?.['path'] ?? params?.['command']) as string | undefined;
          toolNames.set(toolId, toolName);
          ctx.onEvent?.({ type: 'tool_start', name: toolName, file: filePath, description: filePath });
        } else if (type === 'tool_result') {
          const toolId = (obj['tool_id'] ?? '') as string;
          const status = obj['status'] === 'error' ? 'error' as const : 'success' as const;
          const toolName = toolNames.get(toolId) ?? 'unknown';
          ctx.onEvent?.({ type: 'tool_end', name: toolName, status });
        } else if (type === 'assistant') {
          // Older format: full assistant message with content blocks
          const message = obj['message'] as Record<string, unknown> | undefined;
          if (message) {
            const content = message['content'];
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b['type'] === 'text') {
                  const text = (b['text'] ?? '') as string;
                  if (text.length > 0) {
                    ctx.onLog('stdout', text);
                    ctx.onEvent?.({ type: 'content', text });
                  }
                } else if (b['type'] === 'thinking') {
                  const text = (b['thinking'] ?? b['text'] ?? '') as string;
                  if (text.length > 0) {
                    ctx.onEvent?.({ type: 'thinking', text });
                  }
                } else if (b['type'] === 'tool_use') {
                  const toolName = (b['name'] ?? 'unknown') as string;
                  const toolId = (b['id'] ?? '') as string;
                  const input = b['input'] as Record<string, unknown> | undefined;
                  const filePath = (input?.['file_path'] ?? input?.['path'] ?? input?.['command']) as string | undefined;
                  toolNames.set(toolId, toolName);
                  ctx.onEvent?.({ type: 'tool_start', name: toolName, file: filePath, description: filePath });
                }
              }
            }
          }
        } else if (type === 'user') {
          // Tool result — match by tool_use_id
          const msg = obj['message'] as Record<string, unknown> | undefined;
          const content = msg?.['content'];
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b['type'] === 'tool_result') {
                const toolId = (b['tool_use_id'] ?? '') as string;
                const toolName = toolNames.get(toolId) ?? 'unknown';
                ctx.onEvent?.({ type: 'tool_end', name: toolName, status: 'success' });
              }
            }
          }
        }
        // init, result, error types are handled by parseClaudeStreamJson after completion
      } catch {
        // Not valid JSON — forward as-is
        if (line.length > 0) {
          ctx.onLog('stdout', line + '\n');
        }
      }
    };

    const result = await runChildProcess({
      command: resolvedCommand,
      args,
      cwd: ctx.threadContext.worktreePath,
      env,
      stdin: ctx.prompt,
      signal: ctx.signal,
      onLog: (stream, chunk) => {
        if (stream === 'stderr') {
          if (chunk.trim().length > 0) ctx.onLog('stderr', chunk);
          return;
        }
        // stdout: buffer and parse JSONL line-by-line
        stdoutLineBuffer += chunk;
        const lines = stdoutLineBuffer.split('\n');
        // Last element is incomplete — keep in buffer
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) forwardJsonLine(trimmed);
        }
      },
      onSpawn: ctx.onSpawn,
    });

    // Flush remaining buffer
    if (stdoutLineBuffer.trim().length > 0) {
      forwardJsonLine(stdoutLineBuffer.trim());
    }

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
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    };
  }
}

export function createClaudeAdapter(): FixyAdapter {
  return new ClaudeAdapter();
}

export { parseClaudeStreamJson } from './parse.js';
