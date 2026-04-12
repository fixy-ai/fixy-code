// packages/core/src/router.ts

import type { AdapterRegistry } from './registry.js';

export type ParsedInput =
  | { kind: 'mention'; agentIds: string[]; body: string }
  | { kind: 'fixy'; rest: string }
  | { kind: 'bare'; body: string }
  | { kind: 'error'; reason: string };

const MENTION_RE = /^@(\w+)/;

export class Router {
  constructor(private readonly registry: AdapterRegistry) {}

  parse(input: string): ParsedInput {
    if (!input.startsWith('@')) {
      return { kind: 'bare', body: input };
    }

    const tokens: string[] = [];
    let remaining = input;

    while (remaining.startsWith('@')) {
      const match = MENTION_RE.exec(remaining);
      if (!match) break;

      // @fixy as first token: everything after it is the rest
      if (tokens.length === 0 && match[1] === 'fixy') {
        return { kind: 'fixy', rest: remaining.slice(match[0].length).trimStart() };
      }

      tokens.push(match[1]);
      remaining = remaining.slice(match[0].length).trimStart();
    }

    if (tokens.length === 0) {
      return { kind: 'bare', body: input };
    }

    for (const token of tokens) {
      if (!this.registry.has(token)) {
        return { kind: 'error', reason: `unknown agent: @${token}` };
      }
    }

    return { kind: 'mention', agentIds: tokens, body: remaining };
  }
}
