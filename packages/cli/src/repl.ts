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
  { name: '/model',    desc: 'view or change adapter models' },
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
  let spinner: ReturnType<typeof createSpinner> | null = null;

  const allCompletions: string[] = [
    ...SLASH_MENU.map((m) => m.name),
    ...registry.list().map((a) => `@${a.id}`),
    '@fixy',
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
    completer: (line: string): [string[], string] => {
      const hits = allCompletions.filter((c) => c.startsWith(line));
      return [hits.length ? hits : [], line];
    },
  });

  // ── Autocomplete menus (TTY only) ──────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
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
      // Save cursor, move down and erase each menu line, then restore cursor.
      let seq = '\x1b[s'; // save cursor position
      for (let i = 0; i < menuHeight; i++) {
        seq += '\x1b[1B\x1b[2K'; // cursor down 1, erase entire line
      }
      seq += '\x1b[u'; // restore cursor position
      process.stdout.write(seq);
      menuHeight = 0;
    };

    const drawMenu = (items: Array<{ name: string; desc: string }>): void => {
      eraseMenu();
      const lines = items.map(
        (item) =>
          `  ${MENU_INDIGO}${item.name.padEnd(12)}${MENU_RESET}${MENU_DIM}${item.desc}${MENU_RESET}`,
      );
      // Save cursor, print menu below the current prompt line, then restore cursor.
      process.stdout.write('\x1b[s\n' + lines.join('\n') + '\x1b[u');
      menuHeight = lines.length;
    };

    process.stdin.on('keypress', (_str, key) => {
      if (key?.name === 'escape') {
        eraseMenu();
        if (turnActive && turnAbort) {
          turnAbort.abort();
          turnAbort = null;
          turnActive = false;
          spinner?.stop();
          spinner = null;
          process.stdout.write('\x1b[38;5;105m⊘ cancelled\x1b[0m\n');
        } else {
          process.stdout.write('\r\x1b[2K');
          process.stdout.write(PROMPT);
        }
        return;
      }
      if (turnActive) {
        eraseMenu();
        return;
      }
      // Use setImmediate so readline has already updated rl.line before we read it.
      setImmediate(() => {
        const line = rl.line;
        if (line === '@') {
          drawMenu(atMenu);
        } else if (line.startsWith('/')) {
          const filtered = SLASH_MENU.filter((item) =>
            item.name.startsWith(line),
          );
          if (filtered.length > 0) {
            drawMenu(filtered);
          } else {
            eraseMenu();
          }
        } else if (line.startsWith('@') && line.length > 1) {
          const filtered = atMenu.filter((item) => item.name.startsWith(line));
          if (filtered.length > 0) {
            drawMenu(filtered);
          } else {
            eraseMenu();
          }
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
      process.stdout.write('\x1b[38;5;105m(turn cancelled)\x1b[0m\n');
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

  const askChoice = (promptText: string): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question(promptText, (answer) => resolve(answer.trim()));
      rl.once('close', () => resolve(null));
    });

  const resolveModelChoice = async (msgContent: string): Promise<string | null> => {
    // Extract adapter id from MODEL_SELECT @<id>
    const adapterMatch = msgContent.match(/^MODEL_SELECT @(\w+)/);
    const adapterId = adapterMatch?.[1] ?? thread.workerModel;

    while (true) {
      const raw = await askChoice('\x1b[38;5;105m[model]>\x1b[0m ');
      if (raw === null) return null;
      const choice = raw.trim();
      if (choice.length === 0) continue;

      // Ask save preference
      const saveRaw = await askChoice('\x1b[38;5;105mSave globally? (y/n)>\x1b[0m ');
      if (saveRaw === null) return null;
      const save = saveRaw.trim().toLowerCase() === 'y' ? 'y' : 'n';

      return `@fixy /model @${adapterId} apply ${choice} ${save}`;
    }
  };

  const resolveWorkerChoice = async (msgContent: string): Promise<string | null> => {
    const matches = [...msgContent.matchAll(/\[(\d+)\] @(\w+)/g)];
    const adapters = matches.map((m) => m[2]!);
    if (adapters.length === 0) return null;
    const range = `1-${adapters.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}]>\x1b[0m `);
      if (choice === null) return null;
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= adapters.length) return `@fixy /worker ${adapters[n - 1]}`;
      process.stdout.write(`Please type a number between ${range}\n`);
    }
  };

  const resolveDisagreementChoice = async (msgContent: string): Promise<string | null> => {
    const matchA = msgContent.match(/\[1\] Go with @(\w+)/);
    const matchB = msgContent.match(/\[2\] Go with @(\w+)/);
    const agentA = matchA?.[1] ?? thread.workerModel;
    const agentB = matchB?.[1] ?? thread.workerModel;

    while (true) {
      const choice = await askChoice('\x1b[38;5;105m[1/2/3]>\x1b[0m ');
      if (choice === null) return null;
      if (choice === '1') return `@fixy Go with @${agentA}'s approach`;
      if (choice === '2') return `@fixy Go with @${agentB}'s approach`;
      if (choice === '3')
        return `@${agentA} @${agentB} Find a middle ground between both approaches`;
      process.stdout.write('Please type 1, 2, or 3\n');
    }
  };

  const runTurn = async (input: string): Promise<void> => {
    turnAbort = new AbortController();
    turnActive = true;
    spinner = createSpinner();

    try {
      thread = await store.getThread(thread.id, thread.projectRoot);
      // Show spinner only when an external agent will respond (not for @fixy commands)
      const isFixyCommand = /^@fixy\s*\//.test(input);
      if (!isFixyCommand) {
        const mentionMatch = input.match(/^@(\w+)/);
        const targetAgent = mentionMatch?.[1] ?? thread.workerModel ?? 'fixy';
        spinner.start(`@${targetAgent}`);
      }
      let headerPrinted = false;

      await turnController.runTurn({
        thread,
        input,
        registry,
        store,
        onLog: (_stream: 'stdout' | 'stderr', chunk: string, agentId?: string) => {
          if (!headerPrinted && _stream === 'stdout') {
            spinner?.stop();
            spinner = null;
            process.stdout.write(`\x1b[38;5;105m@${agentId ?? ''}\x1b[0m\n`);
            headerPrinted = true;
          }
          process.stdout.write(chunk);
        },
        signal: turnAbort.signal,
        worktreeManager,
      });

      thread = await store.getThread(thread.id, thread.projectRoot);

      const lastMsg = thread.messages[thread.messages.length - 1];
      if (lastMsg && lastMsg.role === 'system') {
        // For interactive protocol messages, strip the first line (protocol keyword) before display.
        const PROTOCOL_PREFIXES = ['WORKER_SELECT', 'MODEL_SELECT'];
        const displayContent = PROTOCOL_PREFIXES.some((p) => lastMsg.content.startsWith(p))
          ? lastMsg.content.split('\n').slice(1).join('\n')
          : lastMsg.content;
        process.stdout.write(`\n${displayContent}\n`);

        if (lastMsg.content.startsWith('AGENTS DISAGREE')) {
          const choiceInput = await resolveDisagreementChoice(lastMsg.content);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            return;
          }
        }

        if (lastMsg.content.startsWith('MODEL_SELECT')) {
          const choiceInput = await resolveModelChoice(lastMsg.content);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            return;
          }
        }

        if (lastMsg.content.startsWith('WORKER_SELECT')) {
          const choiceInput = await resolveWorkerChoice(lastMsg.content);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            return;
          }
        }
      }

      if (lastMsg && lastMsg.warnings.length > 0) {
        for (const w of lastMsg.warnings) {
          process.stderr.write(`warning: ${w}\n`);
        }
      }
    } catch (err) {
      if (turnAbort?.signal.aborted) {
        // cancelled by Ctrl-C, already handled
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
      }
    } finally {
      spinner?.stop();
      spinner = null;
      turnActive = false;
      turnAbort = null;
      process.stdout.write('\n');
    }
  };

  while (true) {
    const line = await ask();

    if (line === null) {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      break;
    }

    // Auto-prefix any /command with @fixy so the router handles it.
    const rawInput = line.trim();
    if (rawInput.length === 0) continue;
    const input = rawInput.startsWith('/') ? `@fixy ${rawInput}` : rawInput;

    if (rawInput === '/quit' || rawInput === '/exit') {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      break;
    }

    await runTurn(input);
  }

  rl.close();
  process.exit(0);
}
