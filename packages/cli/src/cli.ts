#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalThreadStore, AdapterRegistry, TurnController, WorktreeManager } from '@fixy/core';
import { createClaudeAdapter } from '@fixy/claude-adapter';
import { createCodexAdapter } from '@fixy/codex-adapter';
import { startupPanel } from './format.js';
import { startRepl } from './repl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf8'),
) as { version: string };
const version = pkg.version;

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
  registry.register(createCodexAdapter());

  const thread = threadId
    ? await store.getThread(threadId, projectRoot)
    : await store.createThread(projectRoot);

  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');

  process.stdout.write(
    startupPanel(
      version,
      registry.list().map((a) => a.id),
      projectRoot,
      thread.id,
    ) + '\n',
  );

  await startRepl({ thread, store, registry, worktreeManager, turnController, version, projectRoot });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
