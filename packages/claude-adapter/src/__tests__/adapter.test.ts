import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClaudeAdapter } from '../index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FixyExecutionContext, FixyInvocationMeta } from '@fixy/core';

let tmpDir: string;
let originalPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixy-claude-test-'));
  originalPath = process.env.PATH ?? '';

  const mockClaude = path.join(tmpDir, 'claude');
  fs.writeFileSync(
    mockClaude,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "claude-code 1.0.42"
  exit 0
fi

if [[ "$1" == "--print" ]]; then
  RESUME_ID=""
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "--resume" ]]; then
      RESUME_ID="$arg"
    fi
    prev="$arg"
  done

  STDIN_CONTENT=$(cat)
  SESSION_ID=\${RESUME_ID:-"new-session-id-001"}

  echo '{"type":"system","subtype":"init","session_id":"'"$SESSION_ID"'","model":"claude-sonnet-4-6"}'
  echo '{"type":"assistant","session_id":"'"$SESSION_ID"'","message":{"content":[{"type":"text","text":"I received: '"$STDIN_CONTENT"'"}]}}'
  echo '{"type":"result","session_id":"'"$SESSION_ID"'","result":"Mock response to prompt","usage":{"input_tokens":10,"output_tokens":20},"total_cost_usd":0.001}'
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
    agent: { id: 'claude', name: 'Claude Code' },
    threadContext: {
      threadId: 'thread-001',
      projectRoot: tmpDir,
      worktreePath: tmpDir,
      repoRef: null,
    },
    messages: [],
    prompt: 'Hello Claude',
    session: null,
    onLog: () => {},
    onMeta: () => {},
    onSpawn: () => {},
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  } as unknown as FixyExecutionContext;
}

describe('ClaudeAdapter.probe()', () => {
  it('finds the mock claude binary and reports available=true', async () => {
    const adapter = createClaudeAdapter();
    const result = await adapter.probe();

    expect(result.available).toBe(true);
    expect(result.version).toContain('1.0.42');
  });

  it('reports available=false when claude is not on PATH', async () => {
    const adapter = createClaudeAdapter();
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

describe('ClaudeAdapter.execute()', () => {
  it('executes with mock claude and returns expected result', async () => {
    const adapter = createClaudeAdapter();
    const logs: Array<{ stream: string; chunk: string }> = [];
    let metaCalled = false;
    let spawnPid: number | null = null;

    const ctx = makeCtx({
      onLog: (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      onMeta: (_meta: FixyInvocationMeta) => {
        metaCalled = true;
      },
      onSpawn: (pid: number) => {
        spawnPid = pid;
      },
    });

    const result = await adapter.execute(ctx);

    expect(result.summary).toContain('Mock response to prompt');
    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('new-session-id-001');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.patches).toEqual([]);
    expect(metaCalled).toBe(true);
    expect(typeof spawnPid).toBe('number');
    expect(spawnPid).toBeGreaterThan(0);
  });

  it('resumes a session by passing --resume with the session id', async () => {
    const adapter = createClaudeAdapter();

    const ctx = makeCtx({
      session: { sessionId: 'resume-sess-42', params: {} },
    });

    const result = await adapter.execute(ctx);

    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('resume-sess-42');
  });

  it('inherits HOME without redaction (HOME does not match sensitive key regex)', async () => {
    const adapter = createClaudeAdapter();
    let metaEnv: Record<string, string> = {};

    const ctx = makeCtx({
      onMeta: (meta: FixyInvocationMeta) => {
        metaEnv = meta.env;
      },
    });

    await adapter.execute(ctx);

    // HOME does not match /(key|token|secret|password|passwd|authorization|cookie)/i
    // so it must NOT be redacted
    expect(metaEnv['HOME']).not.toBe('***REDACTED***');
    expect(typeof metaEnv['HOME']).toBe('string');
  });

  it('redacts env keys matching the sensitive key pattern', async () => {
    const adapter = createClaudeAdapter();
    let metaEnv: Record<string, string> = {};

    process.env['MY_SECRET_TOKEN'] = 'super-secret';

    const ctx = makeCtx({
      onMeta: (meta: FixyInvocationMeta) => {
        metaEnv = meta.env;
      },
    });

    try {
      await adapter.execute(ctx);
      // "TOKEN" matches /(key|token|secret|password|passwd|authorization|cookie)/i
      expect(metaEnv['MY_SECRET_TOKEN']).toBe('***REDACTED***');
    } finally {
      delete process.env['MY_SECRET_TOKEN'];
    }
  });
});
