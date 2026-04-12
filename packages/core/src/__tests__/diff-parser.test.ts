// packages/core/src/__tests__/diff-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../diff-parser.js';

describe('parseUnifiedDiff', () => {
  it('parses a single file diff correctly', () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { foo } from './foo';
+import { bar } from './bar';

 export function main() {
-  return foo();
+  return bar(foo());
 }
`;
    const patches = parseUnifiedDiff(diff, '/tmp/worktree');

    expect(patches).toHaveLength(1);
    expect(patches[0].relativePath).toBe('src/index.ts');
    expect(patches[0].filePath).toBe('/tmp/worktree/src/index.ts');
    expect(patches[0].stats.additions).toBe(2);
    expect(patches[0].stats.deletions).toBe(1);
  });

  it('parses a multi-file diff correctly', () => {
    const diff = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export { a };
diff --git a/src/file2.ts b/src/file2.ts
index 111..222 100644
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,3 +1,2 @@
 const x = 1;
-const y = 2;
 export { x };
`;
    const patches = parseUnifiedDiff(diff, '/tmp/worktree');

    expect(patches).toHaveLength(2);

    expect(patches[0].relativePath).toBe('file1.ts');
    expect(patches[0].stats.additions).toBe(1);
    expect(patches[0].stats.deletions).toBe(0);

    expect(patches[1].relativePath).toBe('src/file2.ts');
    expect(patches[1].stats.additions).toBe(0);
    expect(patches[1].stats.deletions).toBe(1);
  });

  it('returns an empty array for an empty diff', () => {
    expect(parseUnifiedDiff('', '/tmp/worktree')).toEqual([]);
    expect(parseUnifiedDiff('   \n  \n', '/tmp/worktree')).toEqual([]);
  });

  it('parses a new file diff with only additions', () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,3 @@
+const a = 1;
+const b = 2;
+export { a, b };
`;
    const patches = parseUnifiedDiff(diff, '/tmp/worktree');

    expect(patches).toHaveLength(1);
    expect(patches[0].stats.additions).toBe(3);
    expect(patches[0].stats.deletions).toBe(0);
  });

  it('parses a deleted file diff with only deletions', () => {
    const diff = `diff --git a/removed.ts b/removed.ts
deleted file mode 100644
index abc1234..0000000
--- a/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const old = true;
-export { old };
`;
    const patches = parseUnifiedDiff(diff, '/tmp/worktree');

    expect(patches).toHaveLength(1);
    expect(patches[0].stats.additions).toBe(0);
    expect(patches[0].stats.deletions).toBe(2);
  });
});
