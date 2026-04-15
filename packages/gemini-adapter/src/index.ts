// packages/gemini-adapter/src/index.ts

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

import { parseGeminiOutput, parseListSessions } from './parse.js';

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
  // Preserve trailing newline so streaming chunks don't merge words
  const hadTrailingNewline = text.endsWith('\n');

  // First check if this is a verbose error — extract clean message
  if (text.includes('_GaxiosError') || text.includes('"error"')) {
    const clean = extractCleanError(text);
    if (clean) return clean + (hadTrailingNewline ? '\n' : '');
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
  return hadTrailingNewline ? filtered + '\n' : filtered;
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
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    };
  }
}

export function createGeminiAdapter(): FixyAdapter {
  return new GeminiAdapter();
}

export { parseGeminiOutput, parseListSessions } from './parse.js';
