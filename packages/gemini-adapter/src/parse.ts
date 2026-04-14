export interface GeminiOutputResult {
  summary: string;
  sessionIndex: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Parse plain-text output from `gemini --output-format text`.
 * The stdout is already plain text — return it trimmed as the summary.
 * sessionIndex is resolved separately by parseListSessions().
 */
export function parseGeminiOutput(stdout: string): GeminiOutputResult {
  if (stdout.length === 0) {
    return { summary: '', sessionIndex: null };
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  // Best-effort: look for token usage patterns in the output
  // Gemini CLI may print "Input tokens: N" or "Output tokens: N" in various formats
  const inputMatch = stdout.match(/input[_ ]tokens?\s*[:=]\s*(\d+)/i);
  if (inputMatch) inputTokens = parseInt(inputMatch[1] ?? '', 10) || undefined;
  const outputMatch = stdout.match(/output[_ ]tokens?\s*[:=]\s*(\d+)/i);
  if (outputMatch) outputTokens = parseInt(outputMatch[1] ?? '', 10) || undefined;

  // Remove token usage lines from summary to avoid cluttering output
  let summary = stdout
    .replace(/input[_ ]tokens?\s*[:=]\s*\d+/gi, '')
    .replace(/output[_ ]tokens?\s*[:=]\s*\d+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (summary === '') {
    summary = stdout.trim();
  }

  return { summary, sessionIndex: null, inputTokens, outputTokens };
}

/**
 * Parse output from `gemini --list-sessions` to extract the first session index.
 * Each line is expected to start with a numeric index, e.g.:
 *   0  2026-04-13 10:00:00  some title
 *   1  2026-04-13 11:00:00  another title
 * Returns the index of the first non-empty line as a string (e.g. "0").
 */
export function parseListSessions(stdout: string): string | null {
  if (stdout.trim().length === 0) return null;
  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // First token on the line is the session index (a number)
    const matched = trimmed.match(/^(\d+)/);
    if (matched) return matched[1];
  }
  return null;
}
