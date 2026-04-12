// packages/core/src/diff-parser.ts
import { join } from 'node:path';
import type { FixyPatch } from './thread.js';

export function parseUnifiedDiff(diffOutput: string, worktreePath: string): FixyPatch[] {
  if (!diffOutput || !diffOutput.trim()) {
    return [];
  }

  // Split on diff --git boundaries using lookahead to keep the delimiter with each segment
  const segments = diffOutput.split(/(?=^diff --git )/m).filter((segment) => segment.trim());

  const patches: FixyPatch[] = [];

  for (const segment of segments) {
    // Extract file path from the diff --git header line (b/ side)
    const headerMatch = /^diff --git a\/.+ b\/(.+)$/m.exec(segment);
    if (!headerMatch) {
      continue;
    }

    const relativePath = headerMatch[1].trim();
    const filePath = join(worktreePath, relativePath);

    let additions = 0;
    let deletions = 0;

    const lines = segment.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    patches.push({
      filePath,
      relativePath,
      diff: segment,
      stats: { additions, deletions },
    });
  }

  return patches;
}
