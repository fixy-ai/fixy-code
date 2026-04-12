import { describe, it, expect, beforeEach } from 'vitest';
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

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('register() adds adapters and list() returns them', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));
    expect(registry.list()).toHaveLength(2);
  });

  it('require() returns the correct adapter', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    expect(registry.require('claude').name).toBe('Claude');
  });

  it('require() throws for unknown id', () => {
    expect(() => registry.require('unknown')).toThrow('Unknown adapter: unknown');
  });

  it('register() throws on duplicate id', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    expect(() => registry.register(createStubAdapter('claude', 'Claude 2'))).toThrow(
      'Adapter already registered: claude',
    );
  });

  it('unregister() removes the adapter', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.unregister('claude');
    expect(registry.has('claude')).toBe(false);
  });

  it('unregister() does not throw for unknown id', () => {
    expect(() => registry.unregister('nonexistent')).not.toThrow();
  });

  it('get() returns adapter or undefined', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    expect(registry.get('claude')?.id).toBe('claude');
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('clear() removes all adapters', () => {
    registry.register(createStubAdapter('claude', 'Claude'));
    registry.register(createStubAdapter('codex', 'Codex'));
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});
