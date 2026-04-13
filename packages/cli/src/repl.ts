import readline from 'node:readline';
import type {
  FixyThread,
  LocalThreadStore,
  AdapterRegistry,
  TurnController,
  WorktreeManager,
} from '@fixy/core';
import { loadSettings, loadAuth, heartbeat } from '@fixy/core';
import { PROMPT, createSpinner } from './format.js';

/** Strip markdown bold/italic markers from terminal output. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*([^*\n]+?)\*/gs, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

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
  { name: '/new',      desc: 'create a new terminal session' },
  { name: '/login',    desc: 'sign in to fixy.ai for more features' },
  { name: '/logout',   desc: 'sign out from fixy.ai' },
  { name: '/settings', desc: 'view or update global settings' },
  { name: '/reset',    desc: 'abort current turn and reset agent sessions' },
  { name: '/status',   desc: 'show adapter and session status' },
  { name: '/account',  desc: 'view account, plan & usage' },
  { name: '/upgrade',  desc: 'open plan management in browser' },
  { name: '/red-room', desc: 'toggle adversarial mode on/off' },
  { name: '/quit',     desc: 'exit fixy' },
];

export async function startRepl(params: ReplParams): Promise<void> {
  const { store, registry, worktreeManager, turnController, models } = params;
  let thread = params.thread;

  let turnActive = false;
  let turnAbort: AbortController | null = null;
  let spinner: ReturnType<typeof createSpinner> | null = null;

  const settings = await loadSettings();
  const disabledAdapters = new Set(settings.disabledAdapters ?? []);
  const enabledAdapters = registry.list().filter((a) => !disabledAdapters.has(a.id));

  const allCompletions: string[] = [
    ...SLASH_MENU.map((m) => m.name),
    ...enabledAdapters.map((a) => `@${a.id}`),
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
      ...enabledAdapters.map((a) => ({
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

  // Start heartbeat interval (only if signed in)
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const authForHeartbeat = await loadAuth();
  if (authForHeartbeat) {
    heartbeatTimer = setInterval(() => {
      heartbeat(thread.id).catch(() => {});
    }, 5 * 60 * 1000);
  }

  process.on('exit', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

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

  const askChoice = (promptText: string, signal?: AbortSignal): Promise<string | null> =>
    new Promise((resolve) => {
      if (signal?.aborted) { resolve(null); return; }

      let settled = false;
      const settle = (val: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(val);
      };

      const onAbort = (): void => {
        // Inject a newline to flush readline's pending question cleanly.
        rl.write('\n');
        settle(null);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      rl.once('close', () => settle(null));
      rl.question(promptText, (answer) => {
        signal?.removeEventListener('abort', onAbort);
        settle(answer.trim());
      });
    });

  const resolveModelChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    // Extract adapter id from MODEL_SELECT @<id>
    const adapterMatch = msgContent.match(/^MODEL_SELECT @(\w+)/);
    const adapterId = adapterMatch?.[1] ?? thread.workerModel;

    // Parse model ids from numbered list in the message
    const modelMatches = [...msgContent.matchAll(/\[(\d+)\]\s+([\w.-]+)/g)];
    const modelIds = modelMatches.map((m) => m[2]!);
    const range = modelIds.length > 0 ? `1-${modelIds.length}` : 'model';
    const prompt = modelIds.length > 0
      ? `\x1b[38;5;105m[${range}]>\x1b[0m `
      : `\x1b[38;5;105m[model]>\x1b[0m `;

    while (true) {
      const raw = await askChoice(prompt, signal);
      if (raw === null) return null;
      const choice = raw.trim();
      if (choice.length === 0) continue;

      // Resolve number to model id if applicable
      const n = parseInt(choice, 10);
      const resolvedModel =
        modelIds.length > 0 && n >= 1 && n <= modelIds.length
          ? modelIds[n - 1]!
          : choice;

      // Ask save preference
      const saveRaw = await askChoice('\x1b[38;5;105mSave globally? (y/n)>\x1b[0m ', signal);
      if (saveRaw === null) return null;
      const save = saveRaw.trim().toLowerCase() === 'y' ? 'y' : 'n';

      return `@fixy /model @${adapterId} apply ${resolvedModel} ${save}`;
    }
  };

  const resolveAdapterToggle = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    const matches = [...msgContent.matchAll(/\[(\d+)\] @(\w+)/g)];
    const adapters = matches.map((m) => m[2]!);
    if (adapters.length === 0) return null;
    const range = `1-${adapters.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}] or Enter to dismiss>\x1b[0m `, signal);
      if (choice === null || choice === '') return null;
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= adapters.length) return `@fixy /model @${adapters[n - 1]} toggle`;
      process.stdout.write(`Please type a number between ${range} or press Enter\n`);
    }
  };

  const resolveWorkerChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    const matches = [...msgContent.matchAll(/\[(\d+)\] @(\w+)/g)];
    const adapters = matches.map((m) => m[2]!);
    if (adapters.length === 0) return null;
    const range = `1-${adapters.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}]>\x1b[0m `, signal);
      if (choice === null) return null;
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= adapters.length) return `@fixy /worker ${adapters[n - 1]}`;
      process.stdout.write(`Please type a number between ${range}\n`);
    }
  };

  const resolveDisagreementChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    const matchA = msgContent.match(/\[1\] Go with @(\w+)/);
    const matchB = msgContent.match(/\[2\] Go with @(\w+)/);
    const agentA = matchA?.[1] ?? thread.workerModel;
    const agentB = matchB?.[1] ?? thread.workerModel;

    while (true) {
      const choice = await askChoice('\x1b[38;5;105m[1/2/3]>\x1b[0m ', signal);
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
          process.stdout.write(stripMarkdown(chunk));
        },
        signal: turnAbort.signal,
        worktreeManager,
      });

      thread = await store.getThread(thread.id, thread.projectRoot);

      const lastMsg = thread.messages[thread.messages.length - 1];
      if (lastMsg && lastMsg.role === 'system') {
        // For interactive protocol messages, strip the first line (protocol keyword) before display.
        const PROTOCOL_PREFIXES = ['WORKER_SELECT', 'MODEL_SELECT', 'ADAPTER_TOGGLE_SELECT'];
        const displayContent = PROTOCOL_PREFIXES.some((p) => lastMsg.content.startsWith(p))
          ? lastMsg.content.split('\n').slice(1).join('\n')
          : lastMsg.content;
        process.stdout.write(`\n${displayContent}\n`);

        const interactiveSignal = turnAbort?.signal;

        if (lastMsg.content.startsWith('AGENTS DISAGREE')) {
          const choiceInput = await resolveDisagreementChoice(lastMsg.content, interactiveSignal);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            return;
          }
        }

        if (lastMsg.content.startsWith('ADAPTER_TOGGLE_SELECT')) {
          const choiceInput = await resolveAdapterToggle(lastMsg.content, interactiveSignal);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            // Re-show the updated provider list after toggling
            await runTurn('@fixy /model');
            return;
          }
        }

        if (lastMsg.content.startsWith('MODEL_SELECT')) {
          const choiceInput = await resolveModelChoice(lastMsg.content, interactiveSignal);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            return;
          }
        }

        if (lastMsg.content.startsWith('WORKER_SELECT')) {
          const choiceInput = await resolveWorkerChoice(lastMsg.content, interactiveSignal);
          if (choiceInput !== null) {
            await runTurn(choiceInput);
            // After setting the worker, immediately trigger model selection for it
            const adapterId = choiceInput.match(/@fixy \/worker (\w+)/)?.[1];
            if (adapterId) {
              await runTurn(`@fixy /model @${adapterId}`);
            }
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
