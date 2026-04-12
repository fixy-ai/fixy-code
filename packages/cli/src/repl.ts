import readline from 'node:readline';
import type {
  FixyThread,
  LocalThreadStore,
  AdapterRegistry,
  TurnController,
  WorktreeManager,
} from '@fixy/core';
import { PROMPT, createSpinner } from './format.js';

export interface ReplParams {
  thread: FixyThread;
  store: LocalThreadStore;
  registry: AdapterRegistry;
  worktreeManager: WorktreeManager;
  turnController: TurnController;
  version: string;
  projectRoot: string;
}

export async function startRepl(params: ReplParams): Promise<void> {
  const { store, registry, worktreeManager, turnController } = params;
  let thread = params.thread;

  let turnActive = false;
  let turnAbort: AbortController | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  process.on('SIGINT', () => {
    if (turnActive && turnAbort) {
      turnAbort.abort();
      turnAbort = null;
      turnActive = false;
      process.stdout.write('\x1b[33m(turn cancelled)\x1b[0m\n');
    } else {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      process.exit(0);
    }
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question(PROMPT, (answer) => resolve(answer));
      rl.once('close', () => resolve(null));
    });

  while (true) {
    const line = await ask();

    if (line === null) {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      break;
    }

    const input = line.trim();
    if (input.length === 0) continue;

    if (input === '/quit' || input === '/exit') {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      break;
    }

    turnAbort = new AbortController();
    turnActive = true;

    const spinner = createSpinner();

    try {
      thread = await store.getThread(thread.id, thread.projectRoot);

      spinner.start('thinking...');

      await turnController.runTurn({
        thread,
        input,
        registry,
        store,
        onLog: (_stream: 'stdout' | 'stderr', chunk: string) => {
          process.stdout.write(chunk);
        },
        signal: turnAbort.signal,
        worktreeManager,
      });

      thread = await store.getThread(thread.id, thread.projectRoot);

      const lastMsg = thread.messages[thread.messages.length - 1];
      if (lastMsg && lastMsg.role === 'system') {
        process.stdout.write(`\n${lastMsg.content}\n`);
      }

      if (lastMsg && lastMsg.warnings.length > 0) {
        for (const w of lastMsg.warnings) {
          process.stderr.write(`warning: ${w}\n`);
        }
      }
    } catch (err) {
      if (turnAbort.signal.aborted) {
        // cancelled by Ctrl-C, already handled
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
      }
    } finally {
      spinner.stop();
      turnActive = false;
      turnAbort = null;
    }
  }

  rl.close();
  process.exit(0);
}
