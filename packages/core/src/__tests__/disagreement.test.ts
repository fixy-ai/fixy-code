import { describe, it, expect } from 'vitest';
import { detectDisagreement } from '../disagreement.js';
import type { FixyMessage } from '../thread.js';

function makeMsg(
  agentId: string,
  content: string,
  patches: Array<{ relativePath: string }> = [],
): FixyMessage {
  return {
    id: `msg-${agentId}`,
    createdAt: new Date().toISOString(),
    role: 'agent',
    agentId,
    content,
    runId: null,
    dispatchedTo: [],
    patches: patches.map((p) => ({
      filePath: `/project/${p.relativePath}`,
      relativePath: p.relativePath,
      diff: `diff --git a/${p.relativePath}`,
      stats: { additions: 1, deletions: 0 },
    })),
    warnings: [],
  };
}

describe('detectDisagreement', () => {
  it('returns null when messages have no disagreement signals', () => {
    const msgA = makeMsg('claude', 'I will create a function called processData.');
    const msgB = makeMsg('codex', 'Sounds good, let me implement that.');
    expect(detectDisagreement(msgA, msgB)).toBeNull();
  });

  it('detects contradiction via "instead" keyword in msgB', () => {
    const msgA = makeMsg('claude', 'Use a class-based approach for this.');
    const msgB = makeMsg('codex', 'Instead of a class, we should use a functional approach.');
    const result = detectDisagreement(msgA, msgB);
    expect(result).not.toBeNull();
    expect(result?.agentA).toBe('claude');
    expect(result?.agentB).toBe('codex');
  });

  it('detects contradiction via "however" keyword in msgB', () => {
    const msgA = makeMsg('claude', 'Implement the cache in Redis.');
    const msgB = makeMsg('codex', 'However, Redis adds unnecessary complexity here.');
    expect(detectDisagreement(msgA, msgB)).not.toBeNull();
  });

  it('detects contradiction via "disagree" keyword in msgB', () => {
    const msgA = makeMsg('claude', 'We should use a singleton pattern.');
    const msgB = makeMsg('codex', 'I disagree with the singleton pattern choice.');
    expect(detectDisagreement(msgA, msgB)).not.toBeNull();
  });

  it('detects contradiction via "alternative" keyword in msgB', () => {
    const msgA = makeMsg('claude', 'Use async/await throughout.');
    const msgB = makeMsg('codex', 'An alternative approach would be to use Promise chains.');
    expect(detectDisagreement(msgA, msgB)).not.toBeNull();
  });

  it('detects contradiction via "this approach" keyword in msgB', () => {
    const msgA = makeMsg('claude', 'Mutate the array in place.');
    const msgB = makeMsg('codex', 'This approach is not safe for concurrent access.');
    expect(detectDisagreement(msgA, msgB)).not.toBeNull();
  });

  it('detects conflicting patches on the same file path', () => {
    const msgA = makeMsg('claude', 'Updated the auth module.', [{ relativePath: 'src/auth.ts' }]);
    const msgB = makeMsg('codex', 'Rewrote the auth module differently.', [
      { relativePath: 'src/auth.ts' },
    ]);
    const result = detectDisagreement(msgA, msgB);
    expect(result).not.toBeNull();
    expect(result?.agentA).toBe('claude');
    expect(result?.agentB).toBe('codex');
  });

  it('returns null when patches are on different file paths', () => {
    const msgA = makeMsg('claude', 'Updated auth.', [{ relativePath: 'src/auth.ts' }]);
    const msgB = makeMsg('codex', 'Updated router.', [{ relativePath: 'src/router.ts' }]);
    expect(detectDisagreement(msgA, msgB)).toBeNull();
  });

  it('returns null when msgA has patches but msgB has none', () => {
    const msgA = makeMsg('claude', 'Changed a file.', [{ relativePath: 'src/index.ts' }]);
    const msgB = makeMsg('codex', 'No changes from me.');
    expect(detectDisagreement(msgA, msgB)).toBeNull();
  });

  it('returns DisagreementResult with correct summaries', () => {
    const msgA = makeMsg('claude', 'My implementation summary.');
    const msgB = makeMsg('codex', 'However, my approach is different.');
    const result = detectDisagreement(msgA, msgB);
    expect(result?.summaryA).toBe('My implementation summary.');
    expect(result?.summaryB).toBe('However, my approach is different.');
  });

  it('contradiction keywords are case-insensitive', () => {
    const msgA = makeMsg('claude', 'Use option A.');
    const msgB = makeMsg('codex', 'INSTEAD of option A, use option B.');
    expect(detectDisagreement(msgA, msgB)).not.toBeNull();
  });
});
