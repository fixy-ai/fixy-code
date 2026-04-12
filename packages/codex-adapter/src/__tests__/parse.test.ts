import { describe, it, expect } from 'vitest';
import { parseCodexStreamJson } from '../parse.js';

describe('parseCodexStreamJson', () => {
  it('extracts sessionId from thread.started and text from item.completed', () => {
    const input = [
      JSON.stringify({ type: 'thread.started', thread_id: '019d8183-e8b0-7e33-a2f8-29d950432756' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'Hello.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
      }),
    ].join('\n');

    const result = parseCodexStreamJson(input);

    expect(result.sessionId).toBe('019d8183-e8b0-7e33-a2f8-29d950432756');
    expect(result.summary).toBe('Hello.');
  });

  it('concatenates multiple agent_message items', () => {
    const input = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-multi' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'First part.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Second part.' },
      }),
    ].join('\n');

    const result = parseCodexStreamJson(input);

    expect(result.sessionId).toBe('thread-multi');
    expect(result.summary).toContain('First part.');
    expect(result.summary).toContain('Second part.');
  });

  it('ignores non-agent_message items', () => {
    const input = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-filter' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'tool_call', text: 'should be ignored' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Visible text.' },
      }),
    ].join('\n');

    const result = parseCodexStreamJson(input);

    expect(result.summary).toBe('Visible text.');
    expect(result.summary).not.toContain('should be ignored');
  });

  it('falls back to raw stdout for non-JSON output', () => {
    const input = 'This is plain text output\nNot JSON\n';

    const result = parseCodexStreamJson(input);

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe(input);
  });

  it('returns null sessionId and empty summary for empty string', () => {
    const result = parseCodexStreamJson('');

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe('');
  });

  it('handles missing thread_id in thread.started gracefully', () => {
    const input = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'Response without session.' },
      }),
    ].join('\n');

    const result = parseCodexStreamJson(input);

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe('Response without session.');
  });
});
