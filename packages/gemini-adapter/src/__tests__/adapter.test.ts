import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGeminiAdapter } from '../index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FixyExecutionContext, FixyInvocationMeta } from '@fixy/core';

let tmpDir: string;
let originalPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixy-gemini-test-'));
  originalPath = process.env.PATH ?? '';

  const mockGemini = path.join(tmpDir, 'gemini');
  fs.writeFileSync(
    mockGemini,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "Gemini CLI 0.1.0 (gemini-2.0-flash)"
  exit 0
fi

if [[ "$1" == "--list-sessions" ]]; then
  echo "0  2026-04-13 10:00:00  test session"
  exit 0
fi

if [[ "$1" == "--output-format" ]]; then
  # Emit credentials noise to both stdout and stderr (should be filtered)
  echo "Loaded cached credentials." >&2

  # Check for --resume flag
  if [[ "$3" == "--resume" ]]; then
    echo "Resumed session response from Gemini."
  else
    echo "Mock Gemini response."
  fi
  exit 0
fi

echo "Unknown command" >&2
exit 1
`,
    { mode: 0o755 },
  );

  process.env.PATH = tmpDir + ':' + originalPath;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<FixyExecutionContext> = {}): FixyExecutionContext {
  return {
    runId: 'test-run-001',
    agent: { id: 'gemini', name: 'Gemini CLI' },
    threadContext: {
      threadId: 'thread-001',
      projectRoot: tmpDir,
      worktreePath: tmpDir,
      repoRef: null,
    },
    messages: [],
    prompt: 'Hello Gemini',
    session: null,
    onLog: () => {},
    onMeta: () => {},
    onSpawn: () => {},
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  } as unknown as FixyExecutionContext;
}

describe('GeminiAdapter.probe()', () => {
  it('finds the mock gemini binary and reports available=true', async () => {
    const adapter = createGeminiAdapter();
    const result = await adapter.probe();

    expect(result.available).toBe(true);
    expect(result.version).toContain('0.1.0');
  });

  it('reports available=false when gemini is not on PATH', async () => {
    const adapter = createGeminiAdapter();
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir-fixy-test';

    try {
      const result = await adapter.probe();
      expect(result.available).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('GeminiAdapter.execute()', () => {
  it('executes with mock gemini and returns plain text summary', async () => {
    const adapter = createGeminiAdapter();
    let metaCalled = false;
    let spawnPid: number | null = null;

    const ctx = makeCtx({
      onMeta: (_meta: FixyInvocationMeta) => {
        metaCalled = true;
      },
      onSpawn: (pid: number) => {
        spawnPid = pid;
      },
    });

    const result = await adapter.execute(ctx);

    expect(result.summary).toBe('Mock Gemini response.');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.patches).toEqual([]);
    expect(metaCalled).toBe(true);
    expect(typeof spawnPid).toBe('number');
    expect(spawnPid).toBeGreaterThan(0);
  });

  it('stores session index from --list-sessions after execution', async () => {
    const adapter = createGeminiAdapter();
    const ctx = makeCtx();

    const result = await adapter.execute(ctx);

    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('0');
  });

  it('passes --resume when ctx.session is set', async () => {
    const adapter = createGeminiAdapter();
    let capturedArgs: string[] = [];

    const ctx = makeCtx({
      session: { sessionId: '3', params: {} },
      onMeta: (meta: FixyInvocationMeta) => {
        capturedArgs = meta.args;
      },
    });

    await adapter.execute(ctx);

    expect(capturedArgs).toContain('--resume');
    expect(capturedArgs).toContain('3');
  });

  it('filters credentials noise from stderr', async () => {
    const adapter = createGeminiAdapter();
    const stderrChunks: string[] = [];

    const ctx = makeCtx({
      onLog: (stream, chunk) => {
        if (stream === 'stderr') stderrChunks.push(chunk);
      },
    });

    const result = await adapter.execute(ctx);

    expect(stderrChunks.join('')).not.toContain('Loaded cached credentials.');
    expect(result.warnings.length).toBe(0);
  });

  it('appends extra args from settings after base args and before prompt', async () => {
    const adapter = createGeminiAdapter();
    let capturedArgs: string[] = [];

    const ctx = makeCtx({
      adapterArgs: { gemini: '-m gemini-2.5-pro' },
      onMeta: (meta: FixyInvocationMeta) => {
        capturedArgs = meta.args;
      },
    });

    await adapter.execute(ctx);

    // Base args first
    expect(capturedArgs[0]).toBe('--output-format');
    expect(capturedArgs[1]).toBe('text');
    // Extra args present
    expect(capturedArgs).toContain('-m');
    expect(capturedArgs).toContain('gemini-2.5-pro');
    // Prompt is last
    expect(capturedArgs[capturedArgs.length - 1]).toBe('Hello Gemini');
  });
});
