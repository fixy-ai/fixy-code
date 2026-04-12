import { describe, it, expect } from 'vitest';
import { parseClaudeStreamJson } from '../parse.js';

describe('parseClaudeStreamJson', () => {
  it('extracts sessionId and summary from a result line', () => {
    const input = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc-123',
        model: 'claude-sonnet-4-6',
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-abc-123',
        message: { content: [{ type: 'text', text: 'Hello there!' }] },
      }),
      JSON.stringify({
        type: 'result',
        session_id: 'sess-abc-123',
        result: 'Final answer here',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
      }),
    ].join('\n');

    const result = parseClaudeStreamJson(input);

    expect(result.sessionId).toBe('sess-abc-123');
    expect(result.summary).toBe('Final answer here');
  });

  it('falls back to concatenated assistant content when there is no result line', () => {
    const input = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-no-result' }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-no-result',
        message: { content: [{ type: 'text', text: 'Part 1' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-no-result',
        message: { content: [{ type: 'text', text: 'Part 2' }] },
      }),
    ].join('\n');

    const result = parseClaudeStreamJson(input);

    expect(result.sessionId).toBe('sess-no-result');
    expect(result.summary).toContain('Part 1');
    expect(result.summary).toContain('Part 2');
  });

  it('falls back to raw stdout for completely invalid (non-JSON) output', () => {
    const input = 'This is not JSON at all\nJust random text\n';

    const result = parseClaudeStreamJson(input);

    expect(result.sessionId).toBeNull();
    // summary should be the raw input (the fallback path in parseClaudeStreamJson)
    expect(result.summary).toBe(input);
  });

  it('returns null sessionId and empty summary for an empty string', () => {
    const result = parseClaudeStreamJson('');

    expect(result.sessionId).toBeNull();
    expect(result.summary).toBe('');
  });

  it('uses assistant content as summary when result line has no result field', () => {
    const input = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-empty-result' }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-empty-result',
        message: { content: [{ type: 'text', text: 'Assistant text fallback' }] },
      }),
      // result line exists but has no "result" field
      JSON.stringify({
        type: 'result',
        session_id: 'sess-empty-result',
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    ].join('\n');

    const result = parseClaudeStreamJson(input);

    expect(result.sessionId).toBe('sess-empty-result');
    expect(result.summary).toBe('Assistant text fallback');
  });
});
