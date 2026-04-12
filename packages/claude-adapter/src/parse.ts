export interface ClaudeStreamResult {
  sessionId: string | null;
  summary: string;
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function parseClaudeStreamJson(stdout: string): ClaudeStreamResult {
  if (stdout.length === 0) {
    return { sessionId: null, summary: '' };
  }

  let sessionId: string | null = null;
  const assistantTexts: string[] = [];
  let finalResult: Record<string, unknown> | null = null;

  const lines = stdout.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const obj = tryParseJson(line);
    if (obj === null) continue;

    const type = obj['type'];

    if (type === 'system') {
      if (obj['subtype'] === 'init') {
        sessionId = asString(obj['session_id'], sessionId ?? '');
        if (sessionId === '') sessionId = null;
      }
    } else if (type === 'assistant') {
      const sid = asString(obj['session_id'], '');
      if (sid !== '') sessionId = sid;

      const message = obj['message'];
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        const msg = message as Record<string, unknown>;
        const content = msg['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
              const b = block as Record<string, unknown>;
              if (b['type'] === 'text') {
                const text = asString(b['text'], '');
                if (text !== '') {
                  assistantTexts.push(text);
                }
              }
            }
          }
        }
      }
    } else if (type === 'result') {
      finalResult = obj;
      const sid = asString(obj['session_id'], '');
      if (sid !== '') sessionId = sid;
    }
  }

  let summary: string;

  if (finalResult !== null) {
    const resultText = asString(finalResult['result'], '');
    summary = resultText !== '' ? resultText : assistantTexts.join('\n\n').trim();
    const sid = asString(finalResult['session_id'], '');
    if (sid !== '') sessionId = sid;
  } else {
    summary = assistantTexts.join('\n\n').trim();
  }

  if (summary === '' && sessionId === null) {
    return { sessionId: null, summary: stdout };
  }

  return { sessionId, summary };
}
