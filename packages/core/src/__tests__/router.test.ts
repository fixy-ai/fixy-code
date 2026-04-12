// packages/core/src/__tests__/router.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../router.js';
import { AdapterRegistry } from '../registry.js';
import type { FixyAdapter } from '../adapter.js';

function createStubAdapter(id: string, name: string): FixyAdapter {
  return {
    id,
    name,
    probe: async () => ({
      available: true,
      version: '1.0.0',
      authStatus: 'ok' as const,
      detail: null,
    }),
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: '',
      session: null,
      patches: [],
      warnings: [],
      errorMessage: null,
    }),
  };
}

describe('Router', () => {
  let registry: AdapterRegistry;
  let router: Router;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));
    router = new Router(registry);
  });

  it('rule 1: single mention dispatches to that adapter', () => {
    const result = router.parse('@claude do something');
    expect(result).toEqual({ kind: 'mention', agentIds: ['claude'], body: 'do something' });
  });

  it('rule 2: multi mention dispatches to all in order', () => {
    const result = router.parse('@claude @codex brainstorm');
    expect(result).toEqual({ kind: 'mention', agentIds: ['claude', 'codex'], body: 'brainstorm' });
  });

  it('rule 3: @fixy routes to fixy command handler', () => {
    const result = router.parse('@fixy /status');
    expect(result).toEqual({ kind: 'fixy', rest: '/status' });
  });

  it('rule 3: @fixy /worker with args', () => {
    const result = router.parse('@fixy /worker claude');
    expect(result).toEqual({ kind: 'fixy', rest: '/worker claude' });
  });

  it('rule 4: no mention falls to bare', () => {
    const result = router.parse('just do it');
    expect(result).toEqual({ kind: 'bare', body: 'just do it' });
  });

  it('rule 5: unknown mention returns error', () => {
    const result = router.parse('@unknown do something');
    expect(result).toEqual({ kind: 'error', reason: 'unknown agent: @unknown' });
  });

  it('empty string returns bare', () => {
    const result = router.parse('');
    expect(result).toEqual({ kind: 'bare', body: '' });
  });

  it('@fixy alone with no rest', () => {
    const result = router.parse('@fixy');
    expect(result).toEqual({ kind: 'fixy', rest: '' });
  });

  it('mixed known and unknown mentions returns error for unknown', () => {
    const result = router.parse('@claude @unknown brainstorm');
    expect(result).toEqual({ kind: 'error', reason: 'unknown agent: @unknown' });
  });

  it('@fixy takes priority even with other mentions after', () => {
    const result = router.parse('@fixy @claude do something');
    expect(result).toEqual({ kind: 'fixy', rest: '@claude do something' });
  });
});
