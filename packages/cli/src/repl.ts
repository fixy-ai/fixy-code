import readline from 'node:readline';
import type {
  FixyThread,
  LocalThreadStore,
  AdapterRegistry,
  TurnController,
  WorktreeManager,
} from '@fixy/core';

export interface ReplParams {
  thread: FixyThread;
  store: LocalThreadStore;
  registry: AdapterRegistry;
  worktreeManager: WorktreeManager;
  turnController: TurnController;
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

  // Ctrl-C: first press aborts active turn, second press (or idle) exits
  process.on('SIGINT', () => {
    if (turnActive && turnAbort) {
      turnAbort.abort();
      turnAbort = null;
      turnActive = false;
      process.stdout.write('\n(turn cancelled)\n');
    } else {
      console.log('\nbye');
      process.exit(0);
    }
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question('fixy> ', (answer) => resolve(answer));
      rl.once('close', () => resolve(null));
    });

  while (true) {
    const line = await ask();

    // Ctrl-D or stream closed
    if (line === null) {
      console.log('bye');
      break;
    }

    const input = line.trim();
    if (input.length === 0) continue;

    if (input === '/quit' || input === '/exit') {
      console.log('bye');
      break;
    }

    turnAbort = new AbortController();
    turnActive = true;

    try {
      // Re-read thread from disk to get latest state
      thread = await store.getThread(thread.id, thread.projectRoot);

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

      // Re-read thread after turn to pick up new messages/sessions
      thread = await store.getThread(thread.id, thread.projectRoot);

      // Print warnings from the latest agent message
      const lastMsg = thread.messages[thread.messages.length - 1];
      if (lastMsg && lastMsg.warnings.length > 0) {
        for (const w of lastMsg.warnings) {
          process.stderr.write(`warning: ${w}\n`);
        }
      }
    } catch (err) {
      if (turnAbort.signal.aborted) {
        // Turn was cancelled by Ctrl-C, already handled
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
      }
    } finally {
      turnActive = false;
      turnAbort = null;
    }
  }

  rl.close();
  process.exit(0);
}
