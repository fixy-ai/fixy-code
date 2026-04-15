// packages/gemini-adapter/src/index.ts

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

import { parseListSessions } from './parse.js';

// Gemini CLI emits various noise on stderr/stdout — suppress it.
const GEMINI_NOISE_PATTERNS = [
  'Loaded cached credentials.',
  'Skill "',
  'is overriding the built-in skill',
  'warning: Skill ',
  '_GaxiosError',
  'at Gaxios',
  'at async ',
  'at process.',
  'at Object.',
  'at Function.',
  'config: {',
  'response: {',
  'headers: {',
  'params: {',
  'body: \'<<REDACTED',
  'signal: AbortSignal',
  'signal: [AbortSignal',
  'retry: false',
  'paramsSerializer:',
  'validateStatus:',
  'errorRedactor:',
  'responseURL:',
  'statusText:',
  'responseType:',
  '[Symbol(',
  'error: undefined',
  'x-cloudaicompanion',
  'x-content-type',
  'x-frame-options',
  'x-xss-protection',
  'alt-svc:',
  'content-length:',
  'content-type:',
  'server-timing:',
  'server:',
  'vary:',
  'date:',
  'Authorization:',
  'User-Agent:',
  'x-goog-api-client',
  'url:',
  'method:',
  'data:',
  'status:',
];

// Extract a clean error message from Gemini's verbose error output
const GEMINI_ERROR_RE = /(?:"message":\s*"([^"]+)"|"reason":\s*"([^"]+)")/g;
const GEMINI_HTTP_STATUS_RE = /\b(429|500|503|401|403)\b/;

function extractCleanError(text: string): string | null {
  const statusMatch = GEMINI_HTTP_STATUS_RE.exec(text);
  const messages: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = GEMINI_ERROR_RE.exec(text)) !== null) {
    const msg = match[1] ?? match[2];
    if (msg && !messages.includes(msg)) messages.push(msg);
  }
  if (messages.length > 0) {
    const status = statusMatch ? ` (${statusMatch[1]})` : '';
    return `error${status}: ${messages[0]}`;
  }
  return null;
}

function filterGeminiNoise(text: string): string {
  // Preserve leading/trailing whitespace so streaming chunks don't merge words.
  // Chunks can break at any byte boundary — a leading space may be the word
  // separator from the previous chunk.
  const leadingWS = text.match(/^(\s*)/)?.[1] ?? '';
  const trailingWS = text.match(/(\s*)$/)?.[1] ?? '';

  // First check if this is a verbose error — extract clean message
  if (text.includes('_GaxiosError') || text.includes('"error"')) {
    const clean = extractCleanError(text);
    if (clean) return leadingWS + clean + trailingWS;
  }

  const filtered = text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      return !GEMINI_NOISE_PATTERNS.some((p) => trimmed.includes(p));
    })
    .join('\n')
    .trim();

  if (filtered.length === 0) return '';
  return leadingWS + filtered + trailingWS;
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
    // Gemini CLI doesn't expose its active model in config or --version.
    // It uses "Auto" mode (picks best model per task) unless user sets -m.
    // We can only detect the model name if it appears in --version output.
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
      // Only match actual gemini model names (not the CLI version number)
      const modelMatch = output.match(/gemini-[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9-]+)*/);
      if (modelMatch) return modelMatch[0].trim();
    } catch {
      // Ignore
    }
    // Return null — don't return CLI version as a model name
    return null;
  }

  async listModels(): Promise<FixyModelInfo[]> {
    // 1. Try fixy.ai dynamic model list (curated, always current)
    try {
      const { fetchProviderModels } = await import('@fixy/core');
      const providers = await fetchProviderModels();
      const gemini = providers.find((p) => p.provider === 'gemini');
      if (gemini && gemini.models.length > 0) {
        return gemini.models.map((m) => ({ id: m.id, description: m.description }));
      }
    } catch {
      /* fixy.ai unreachable — continue */
    }

    // 2. Try Google API — using API key from env or OAuth token from Gemini CLI
    const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    let oauthToken: string | null = null;
    if (!apiKey) {
      try {
        const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        const raw = await fs.readFile(credsPath, 'utf8');
        const creds = JSON.parse(raw) as { access_token?: string };
        oauthToken = creds.access_token ?? null;
      } catch {
        /* no oauth creds */
      }
    }

    if (apiKey || oauthToken) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const url = apiKey
          ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
          : 'https://generativelanguage.googleapis.com/v1beta/models';
        const headers: Record<string, string> = {};
        if (!apiKey && oauthToken) {
          headers['Authorization'] = `Bearer ${oauthToken}`;
        }
        let response: Response;
        try {
          response = await fetch(url, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          const json = (await response.json()) as {
            models: Array<{ name: string; displayName: string }>;
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
        /* API failed — continue */
      }
    }

    // 3. Read current model from Gemini CLI
    const current = await this.getActiveModel();
    const models: FixyModelInfo[] = [];
    if (current) {
      models.push({ id: current, description: 'Currently active' });
    }
    return models;
  }

  async execute(ctx: FixyExecutionContext): Promise<FixyExecutionResult> {
    const resolvedCommand = await resolveCommand('gemini');
    const env = buildInheritedEnv({});

    // Extra args: thread override takes priority over global setting
    const settings = await loadSettings();
    const extraArgsStr = ctx.adapterArgs?.['gemini'] ?? settings.geminiArgs;
    const extraArgs = extraArgsStr.trim().length > 0 ? extraArgsStr.trim().split(/\s+/) : [];

    const args: string[] = ['--output-format', 'stream-json'];

    if (ctx.session) {
      args.push('--resume', ctx.session.sessionId);
    }

    // Inject model: per-invocation override (worker) takes priority over global setting
    const geminiModel = ctx.modelOverride?.trim() || settings.geminiModel.trim();
    if (geminiModel.length > 0) {
      args.push('--model', geminiModel);
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

    // Buffer partial stdout lines for JSONL parsing
    let stdoutLineBuffer = '';
    const contentTexts: string[] = [];
    let sessionId: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    // Track tool_id → tool_name for correlating tool_result events
    const toolNames = new Map<string, string>();

    const forwardJsonLine = (line: string): void => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const type = obj['type'] as string | undefined;

        if (type === 'init') {
          sessionId = (obj['session_id'] ?? null) as string | null;
        } else if (type === 'message' && obj['role'] === 'assistant') {
          const content = (obj['content'] ?? '') as string;
          if (content.length > 0) {
            ctx.onLog('stdout', content);
            ctx.onEvent?.({ type: 'content', text: content });
            contentTexts.push(content);
          }
        } else if (type === 'tool_use') {
          const toolName = (obj['tool_name'] ?? 'unknown') as string;
          const toolId = (obj['tool_id'] ?? '') as string;
          const params = obj['parameters'] as Record<string, unknown> | undefined;
          const filePath = (params?.['file_path'] ?? params?.['path'] ?? params?.['command']) as string | undefined;
          toolNames.set(toolId, toolName);
          ctx.onEvent?.({ type: 'tool_start', name: toolName, file: filePath, description: filePath });
        } else if (type === 'tool_result') {
          const toolId = (obj['tool_id'] ?? '') as string;
          const status = obj['status'] === 'error' ? 'error' as const : 'success' as const;
          const toolName = toolNames.get(toolId) ?? 'unknown';
          ctx.onEvent?.({ type: 'tool_end', name: toolName, status });
        } else if (type === 'result') {
          const stats = obj['stats'] as Record<string, unknown> | undefined;
          if (stats) {
            if (typeof stats['input_tokens'] === 'number') inputTokens = stats['input_tokens'];
            if (typeof stats['output_tokens'] === 'number') outputTokens = stats['output_tokens'];
          }
          const sid = (obj['session_id'] ?? null) as string | null;
          if (sid) sessionId = sid;
        } else if (type === 'error') {
          const msg = (obj['message'] ?? '') as string;
          if (msg.length > 0) ctx.onLog('stderr', msg + '\n');
        }
      } catch {
        // Not valid JSON — filter noise and forward as plain text
        const filtered = filterGeminiNoise(line);
        if (filtered.length > 0) {
          ctx.onLog('stdout', filtered + '\n');
          contentTexts.push(filtered);
        }
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
          const filtered = filterGeminiNoise(chunk);
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

    // Flush remaining buffer
    if (stdoutLineBuffer.trim().length > 0) {
      forwardJsonLine(stdoutLineBuffer.trim());
    }

    // Resolve the session index for the turn we just ran via --list-sessions.
    // The first line of that output holds the most-recent session index.
    let sessionIndex: string | null = sessionId;
    if (!sessionIndex) {
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
    }

    const summary = contentTexts.join('').trim();

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
      summary,
      session: sessionIndex !== null ? { sessionId: sessionIndex, params: {} } : null,
      patches: [],
      warnings,
      errorMessage,
      inputTokens,
      outputTokens,
    };
  }
}

export function createGeminiAdapter(): FixyAdapter {
  return new GeminiAdapter();
}

export { parseGeminiOutput, parseListSessions } from './parse.js';
