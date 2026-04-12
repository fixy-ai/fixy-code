#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { LocalThreadStore, AdapterRegistry, TurnController, WorktreeManager } from '@fixy/core';
import { createClaudeAdapter } from '@fixy/claude-adapter';
import { banner } from './format.js';
import { startRepl } from './repl.js';

async function findGitRoot(dir: string): Promise<string | null> {
  let current = dir;
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function main(): Promise<void> {
  const gitRoot = await findGitRoot(process.cwd());
  if (!gitRoot) {
    process.stderr.write(
      'Error: not inside a git repository. Run fixy from within a git project.\n',
    );
    process.exit(1);
  }
  const projectRoot: string = gitRoot;

  // Parse args: --thread <id>
  let threadId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--thread' && args[i + 1]) {
      threadId = args[++i];
    }
  }

  const store = new LocalThreadStore();
  await store.init();

  const registry = new AdapterRegistry();
  const worktreeManager = new WorktreeManager();
  const turnController = new TurnController();

  registry.register(createClaudeAdapter());

  const thread = threadId
    ? await store.getThread(threadId, projectRoot)
    : await store.createThread(projectRoot);

  console.log(
    banner(
      '0.0.0',
      registry.list().map((a) => a.id),
    ),
  );
  console.log(`thread: ${thread.id}`);

  await startRepl({ thread, store, registry, worktreeManager, turnController });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
