#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalThreadStore, AdapterRegistry, TurnController, WorktreeManager } from '@fixy/core';
import { createClaudeAdapter } from '@fixy/claude-adapter';
import { createCodexAdapter } from '@fixy/codex-adapter';
import { createGeminiAdapter } from '@fixy/gemini-adapter';
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

function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number);
  const [rMaj = 0, rMin = 0, rPat = 0] = parse(remote);
  const [lMaj = 0, lMin = 0, lPat = 0] = parse(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

async function checkForUpdate(localVersion: string): Promise<void> {
  const INDIGO = '\x1b[38;5;105m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 3000),
    );
    const fetched = fetch('https://registry.npmjs.org/@fixy/code/latest').then(
      (r) => r.json() as Promise<{ version: string }>,
    );
    const data = await Promise.race([fetched, timeout]);
    if (!isNewerVersion(data.version, localVersion)) return;

    const remoteVersion = data.version;
    process.stdout.write(
      `${INDIGO}  ℹ  fixy v${remoteVersion} available — update now? (y/n) ${RESET}`,
    );

    const answer = await new Promise<string>((resolve) => {
      if (!process.stdin.isTTY) { resolve('n'); return; }
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', (buf) => {
        const key = buf.toString();
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(key);
      });
    });

    process.stdout.write(`${answer === 'y' ? 'y' : 'n'}\n`);

    if (answer !== 'y') return;

    process.stdout.write(`${DIM}  updating…${RESET}\n`);
    // Safe: command is a hardcoded literal, no user input involved
    const { execSync } = await import('node:child_process');
    try {
      execSync('npm install -g @fixy/code --registry https://registry.npmjs.org', { stdio: 'inherit' });
      process.stdout.write(`${INDIGO}  ✓  updated to v${remoteVersion} — restart fixy${RESET}\n`);
    } catch {
      process.stdout.write(`\x1b[31m  ✗  update failed — run: npm install -g @fixy/code${RESET}\n`);
    }
    process.exit(0);
  } catch {
    // fetch failed, timed out, or versions match — stay silent
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
  registry.register(createGeminiAdapter());

  // Collect active model names from each adapter (best-effort, null if unavailable).
  const adapterList = registry.list();
  const modelEntries = await Promise.all(
    adapterList.map(async (a) => {
      const model =
        typeof a.getActiveModel === 'function' ? await a.getActiveModel() : null;
      return [a.id, model] as [string, string | null];
    }),
  );
  const models: Record<string, string | null> = Object.fromEntries(modelEntries);

  const thread = threadId
    ? await store.getThread(threadId, projectRoot)
    : await store.createThread(projectRoot);

  // Start update check early so the network request runs while we render the panel.
  const updateCheck = checkForUpdate(version);

  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');

  process.stdout.write(
    startupPanel(
      version,
      registry.list().map((a) => a.id),
      models,
      projectRoot,
      thread.id,
    ) + '\n',
  );

  // Await here — at most 3 s, usually near-instant because the fetch already started.
  await updateCheck;

  await startRepl({ thread, store, registry, worktreeManager, turnController, version, projectRoot, models });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
