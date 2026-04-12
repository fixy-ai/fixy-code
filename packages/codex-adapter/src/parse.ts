export interface CodexStreamResult {
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

export function parseCodexStreamJson(stdout: string): CodexStreamResult {
  if (stdout.length === 0) {
    return { sessionId: null, summary: '' };
  }

  let sessionId: string | null = null;
  const agentTexts: string[] = [];

  const lines = stdout.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const obj = tryParseJson(line);
    if (obj === null) continue;

    const type = obj['type'];

    if (type === 'thread.started') {
      // {"type":"thread.started","thread_id":"<uuid>"}
      const tid = asString(obj['thread_id'], '');
      if (tid !== '') sessionId = tid;
    } else if (type === 'item.completed') {
      // {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
      const item = obj['item'];
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const it = item as Record<string, unknown>;
        if (it['type'] === 'agent_message') {
          const text = asString(it['text'], '');
          if (text !== '') agentTexts.push(text);
        }
      }
    }
  }

  const summary = agentTexts.join('\n\n').trim();

  if (summary === '' && sessionId === null) {
    return { sessionId: null, summary: stdout };
  }

  return { sessionId, summary };
}
