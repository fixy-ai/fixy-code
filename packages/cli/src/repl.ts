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
  models: Record<string, string | null>;
}

// ANSI helpers for the autocomplete menu (kept local — not exported from format.ts)
const MENU_INDIGO = '\x1b[38;5;105m';
const MENU_DIM = '\x1b[2m';
const MENU_RESET = '\x1b[0m';

const SLASH_MENU: Array<{ name: string; desc: string }> = [
  { name: '/all',      desc: 'run collaboration engine on all agents' },
  { name: '/worker',   desc: 'set the worker adapter for this thread' },
  { name: '/settings', desc: 'view or update global settings' },
  { name: '/reset',    desc: 'abort current turn and reset agent sessions' },
  { name: '/status',   desc: 'show adapter and session status' },
  { name: '/red-room', desc: 'toggle adversarial mode on/off' },
  { name: '/quit',     desc: 'exit fixy' },
];

export async function startRepl(params: ReplParams): Promise<void> {
  const { store, registry, worktreeManager, turnController, models } = params;
  let thread = params.thread;

  let turnActive = false;
  let turnAbort: AbortController | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  // ── Autocomplete menus (TTY only) ──────────────────────────────────────────
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);

    const atMenu: Array<{ name: string; desc: string }> = [
      ...registry.list().map((a) => ({
        name: `@${a.id}`,
        desc: `${a.name}${models[a.id] ? ` (${models[a.id]})` : ''}`,
      })),
      { name: '@fixy', desc: 'Fixy worker / commands' },
    ];

    let menuHeight = 0;

    const eraseMenu = (): void => {
      if (menuHeight === 0) return;
      // Move down through each menu line and erase it, then come back up.
      let seq = '';
      for (let i = 0; i < menuHeight; i++) {
        seq += '\x1b[1B\x1b[2K'; // cursor down 1, erase entire line
      }
      seq += `\x1b[${menuHeight}A`; // cursor back up
      process.stdout.write(seq);
      menuHeight = 0;
    };

    const drawMenu = (items: Array<{ name: string; desc: string }>): void => {
      eraseMenu();
      const lines = items.map(
        (item) =>
          `  ${MENU_INDIGO}${item.name.padEnd(12)}${MENU_RESET}${MENU_DIM}${item.desc}${MENU_RESET}`,
      );
      // Print menu below the current prompt line, then move cursor back up.
      process.stdout.write('\n' + lines.join('\n') + `\x1b[${lines.length}A\r`);
      menuHeight = lines.length;
    };

    process.stdin.on('keypress', (_str, _key) => {
      if (turnActive) {
        eraseMenu();
        return;
      }
      // Use setImmediate so readline has already updated rl.line before we read it.
      setImmediate(() => {
        const line = rl.line;
        if (line === '/') {
          drawMenu(SLASH_MENU);
        } else if (line === '@') {
          drawMenu(atMenu);
        } else {
          eraseMenu();
        }
      });
    });

    // Clear menu when the user submits a line.
    rl.on('line', () => eraseMenu());
  }
  // ──────────────────────────────────────────────────────────────────────────

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
