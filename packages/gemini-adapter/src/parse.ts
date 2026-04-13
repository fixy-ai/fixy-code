export interface GeminiOutputResult {
  summary: string;
  sessionIndex: string | null;
}

/**
 * Parse plain-text output from `gemini --output-format text`.
 * The stdout is already plain text — return it trimmed as the summary.
 * sessionIndex is resolved separately by parseListSessions().
 */
export function parseGeminiOutput(stdout: string): GeminiOutputResult {
  return { summary: stdout.trim(), sessionIndex: null };
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
