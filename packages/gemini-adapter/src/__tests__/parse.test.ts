import { describe, it, expect } from 'vitest';
import { parseGeminiOutput, parseListSessions } from '../parse.js';

describe('parseGeminiOutput', () => {
  it('returns trimmed stdout as summary', () => {
    const result = parseGeminiOutput('  Hello from Gemini.\n  ');
    expect(result.summary).toBe('Hello from Gemini.');
    expect(result.sessionIndex).toBeNull();
  });

  it('handles empty string gracefully', () => {
    const result = parseGeminiOutput('');
    expect(result.summary).toBe('');
    expect(result.sessionIndex).toBeNull();
  });

  it('returns multi-line output trimmed', () => {
    const result = parseGeminiOutput('Line one.\nLine two.\n');
    expect(result.summary).toBe('Line one.\nLine two.');
  });
});

describe('parseListSessions', () => {
  it('extracts index from first non-empty line', () => {
    const stdout = '0  2026-04-13 10:00:00  my session\n1  2026-04-13 11:00:00  other';
    expect(parseListSessions(stdout)).toBe('0');
  });

  it('handles leading whitespace on first line', () => {
    const stdout = '  2  2026-04-13 12:00:00  padded';
    expect(parseListSessions(stdout)).toBe('2');
  });

  it('returns null for empty output', () => {
    expect(parseListSessions('')).toBeNull();
    expect(parseListSessions('   \n\n  ')).toBeNull();
  });

  it('returns null when no line starts with a number', () => {
    const stdout = 'No sessions found.\nTry again later.';
    expect(parseListSessions(stdout)).toBeNull();
  });

  it('handles single-line output', () => {
    expect(parseListSessions('5  some session')).toBe('5');
  });
});
