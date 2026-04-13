import type { FixyMessage } from './thread.js';

export interface DisagreementResult {
  agentA: string;
  summaryA: string;
  agentB: string;
  summaryB: string;
}

const CONTRADICTION_KEYWORDS = ['instead', 'however', 'disagree', 'alternative', 'this approach'];

function extractPatchPaths(msg: FixyMessage): Set<string> {
  const paths = new Set<string>();
  for (const patch of msg.patches) {
    paths.add(patch.relativePath);
  }
  return paths;
}

function hasConflictingPatches(msgA: FixyMessage, msgB: FixyMessage): boolean {
  const pathsA = extractPatchPaths(msgA);
  if (pathsA.size === 0) return false;
  const pathsB = extractPatchPaths(msgB);
  for (const path of pathsA) {
    if (pathsB.has(path)) return true;
  }
  return false;
}

function hasContradictionKeyword(content: string): boolean {
  const lower = content.toLowerCase();
  return CONTRADICTION_KEYWORDS.some((kw) => lower.includes(kw));
}

export function detectDisagreement(
  msgA: FixyMessage,
  msgB: FixyMessage,
): DisagreementResult | null {
  const agentA = msgA.agentId ?? 'unknown';
  const agentB = msgB.agentId ?? 'unknown';

  // Heuristic 1: Agent B explicitly contradicts Agent A via keywords
  if (hasContradictionKeyword(msgB.content)) {
    return { agentA, summaryA: msgA.content, agentB, summaryB: msgB.content };
  }

  // Heuristic 2: Both agents produced patches on the same file path
  if (hasConflictingPatches(msgA, msgB)) {
    return { agentA, summaryA: msgA.content, agentB, summaryB: msgB.content };
  }

  return null;
}
