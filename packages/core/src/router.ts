// packages/core/src/router.ts

import type { AdapterRegistry } from './registry.js';

export type ParsedInput =
  | { kind: 'mention'; agentIds: string[]; body: string }
  | { kind: 'fixy'; rest: string }
  | { kind: 'bare'; body: string }
  | { kind: 'error'; reason: string };

const MENTION_RE = /^@(\w+)/;
const INLINE_MENTION_RE = /@(\w+)/g;

export class Router {
  constructor(private readonly registry: AdapterRegistry) {}

  parse(input: string): ParsedInput {
    // ── Leading mentions (original behavior) ──
    if (input.startsWith('@')) {
      const tokens: string[] = [];
      let remaining = input;

      while (remaining.startsWith('@')) {
        const match = MENTION_RE.exec(remaining);
        if (!match) break;

        if (tokens.length === 0 && match[1] === 'fixy') {
          return { kind: 'fixy', rest: remaining.slice(match[0].length).trimStart() };
        }

        if (tokens.length === 0 && match[1] === 'all') {
          const body = remaining.slice(match[0].length).trimStart();
          return { kind: 'fixy', rest: `/all ${body}`.trimEnd() };
        }

        tokens.push(match[1]);
        remaining = remaining.slice(match[0].length).trimStart();
      }

      if (tokens.length > 0) {
        for (const token of tokens) {
          if (!this.registry.has(token)) {
            return { kind: 'error', reason: `unknown agent: @${token}` };
          }
        }
        return { kind: 'mention', agentIds: tokens, body: remaining };
      }
    }

    // ── Inline mentions anywhere in text ──
    const inlineMatches = [...input.matchAll(INLINE_MENTION_RE)];
    if (inlineMatches.length > 0) {
      // Check for @all anywhere
      if (inlineMatches.some((m) => m[1] === 'all')) {
        const body = input.replace(/@all/g, '').trim();
        return { kind: 'fixy', rest: `/all ${body}`.trimEnd() };
      }

      // Check for @fixy anywhere
      if (inlineMatches.some((m) => m[1] === 'fixy')) {
        const body = input.replace(/@fixy/g, '').trim();
        return { kind: 'fixy', rest: body };
      }

      // Check for agent mentions anywhere
      const agentIds: string[] = [];
      for (const m of inlineMatches) {
        const id = m[1];
        if (id && this.registry.has(id) && !agentIds.includes(id)) {
          agentIds.push(id);
        }
      }

      if (agentIds.length > 0) {
        // Strip mentions from the body
        const body = input.replace(INLINE_MENTION_RE, '').trim();
        return { kind: 'mention', agentIds, body };
      }
    }

    return { kind: 'bare', body: input };
  }
}
