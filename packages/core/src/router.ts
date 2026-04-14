// packages/core/src/router.ts

import type { AdapterRegistry } from './registry.js';

export type ParsedInput =
  | { kind: 'mention'; agentIds: string[]; body: string; fileRefs: string[] }
  | { kind: 'fixy'; rest: string }
  | { kind: 'bare'; body: string; fileRefs: string[] }
  | { kind: 'error'; reason: string };

const MENTION_RE = /^@(\w+)/;
const INLINE_MENTION_RE = /@(\w+)/g;
const FILE_REF_RE = /@(\.[\w./\\-]+|[\w.-]+\/[\w./\\-]*)/g;

export class Router {
  constructor(private readonly registry: AdapterRegistry) {}

  _extractFileRefs(input: string): { fileRefs: string[]; cleaned: string } {
    const fileRefs: string[] = [];
    const cleaned = input.replace(FILE_REF_RE, (_match, path: string) => {
      fileRefs.push(path);
      return '';
    }).replace(/\s{2,}/g, ' ').trim();
    return { fileRefs, cleaned };
  }

  parse(input: string): ParsedInput {
    // ── Extract file references before any other processing ──
    const { fileRefs, cleaned } = this._extractFileRefs(input);
    input = cleaned;

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
        return { kind: 'mention', agentIds: tokens, body: remaining, fileRefs };
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
        return { kind: 'mention', agentIds, body, fileRefs };
      }
    }

    return { kind: 'bare', body: input, fileRefs };
  }
}
