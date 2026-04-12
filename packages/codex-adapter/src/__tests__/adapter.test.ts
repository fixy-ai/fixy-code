import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCodexAdapter } from '../index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FixyExecutionContext, FixyInvocationMeta } from '@fixy/core';

let tmpDir: string;
let originalPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixy-codex-test-'));
  originalPath = process.env.PATH ?? '';

  const mockCodex = path.join(tmpDir, 'codex');
  fs.writeFileSync(
    mockCodex,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "codex-cli 0.112.0"
  exit 0
fi

if [[ "$1" == "exec" ]]; then
  # Check for resume subcommand
  THREAD_ID="mock-thread-001"
  if [[ "$2" == "resume" ]]; then
    THREAD_ID="$3"
  fi

  # Emit noise to stderr (should be filtered)
  echo "2026-04-12T11:46:37.355150Z ERROR codex_core::skills::loader: failed to stat skills entry" >&2

  echo '{"type":"thread.started","thread_id":"'"\$THREAD_ID"'"}'
  echo '{"type":"turn.started"}'
  echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Mock codex response."}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}'
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
    agent: { id: 'codex', name: 'Codex CLI' },
    threadContext: {
      threadId: 'thread-001',
      projectRoot: tmpDir,
      worktreePath: tmpDir,
      repoRef: null,
    },
    messages: [],
    prompt: 'Hello Codex',
    session: null,
    onLog: () => {},
    onMeta: () => {},
    onSpawn: () => {},
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  } as unknown as FixyExecutionContext;
}

describe('CodexAdapter.probe()', () => {
  it('finds the mock codex binary and reports available=true', async () => {
    const adapter = createCodexAdapter();
    const result = await adapter.probe();

    expect(result.available).toBe(true);
    expect(result.version).toContain('0.112.0');
  });

  it('reports available=false when codex is not on PATH', async () => {
    const adapter = createCodexAdapter();
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

describe('CodexAdapter.execute()', () => {
  it('executes with mock codex and returns expected result', async () => {
    const adapter = createCodexAdapter();
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

    expect(result.summary).toBe('Mock codex response.');
    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('mock-thread-001');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.patches).toEqual([]);
    expect(metaCalled).toBe(true);
    expect(typeof spawnPid).toBe('number');
    expect(spawnPid).toBeGreaterThan(0);
  });

  it('resumes a session by passing the thread id to codex exec resume', async () => {
    const adapter = createCodexAdapter();

    const ctx = makeCtx({
      session: { sessionId: 'resume-thread-42', params: {} },
    });

    const result = await adapter.execute(ctx);

    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('resume-thread-42');
  });

  it('filters codex startup noise from stderr', async () => {
    const adapter = createCodexAdapter();
    const stderrChunks: string[] = [];

    const ctx = makeCtx({
      onLog: (stream, chunk) => {
        if (stream === 'stderr') stderrChunks.push(chunk);
      },
    });

    const result = await adapter.execute(ctx);

    // The mock writes an ERROR codex_core line to stderr — it should be filtered
    expect(stderrChunks.join('')).not.toContain('codex_core::skills::loader');
    expect(result.warnings.length).toBe(0);
  });

  it('forwards only agent_message text to stdout onLog, not raw JSON', async () => {
    const adapter = createCodexAdapter();
    const stdoutChunks: string[] = [];

    const ctx = makeCtx({
      onLog: (stream, chunk) => {
        if (stream === 'stdout') stdoutChunks.push(chunk);
      },
    });

    await adapter.execute(ctx);

    const output = stdoutChunks.join('');
    expect(output).toContain('Mock codex response.');
    expect(output).not.toContain('thread.started');
    expect(output).not.toContain('turn.started');
    expect(output).not.toContain('turn.completed');
  });

  it('inherits CODEX_HOME from process.env', async () => {
    const adapter = createCodexAdapter();
    let metaEnv: Record<string, string> = {};

    process.env['CODEX_HOME'] = '/custom/codex/home';

    const ctx = makeCtx({
      onMeta: (meta: FixyInvocationMeta) => {
        metaEnv = meta.env;
      },
    });

    try {
      await adapter.execute(ctx);
      expect(metaEnv['CODEX_HOME']).toBe('/custom/codex/home');
    } finally {
      delete process.env['CODEX_HOME'];
    }
  });
});
