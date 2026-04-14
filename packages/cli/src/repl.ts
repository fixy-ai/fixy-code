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

// ── ANSI color constants for output styling ──
const OUT_RESET = '\x1b[0m';
const OUT_TEXT = '\x1b[38;5;252m';   // light gray — agent speech
const OUT_CODE = '\x1b[97m';         // bright white — code
const OUT_CODE_FENCE = '\x1b[2;36m'; // dim cyan — ``` markers
const OUT_HEADING = '\x1b[1;97m';    // bold bright white — headings
const OUT_STDERR = '\x1b[2;31m';     // dim red — stderr
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[/;           // detect pre-colored lines

/** Strip markdown formatting from terminal output. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^(\s*)\*\s+/gm, '$1• ')            // * bullet → • (must be before bold/italic)
    .replace(/^(\s*)-\s+/gm, '$1• ')             // - bullet → •
    .replace(/^(\s*)\d+\.\s+/gm, '$1')           // 1. numbered list → strip number
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')        // ***bold italic***
    .replace(/\*\*(.+?)\*\*/gs, '$1')            // **bold**
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '$1')  // *italic*
    .replace(/^#{1,6}\s+/gm, '')                 // ## headings
    .replace(/`([^`\n]+)`/g, '$1');               // `inline code`
}

/**
 * Colorize streamed output: code blocks bright, text dim, stderr red.
 * Tracks code-fence state across calls via the returned object.
 */
function createColorizer(): {
  colorize: (stream: 'stdout' | 'stderr', chunk: string) => string;
} {
  let inCodeBlock = false;

  return {
    colorize(stream: 'stdout' | 'stderr', chunk: string): string {
      if (stream === 'stderr') {
        return `${OUT_STDERR}${stripMarkdown(chunk)}${OUT_RESET}`;
      }

      const lines = chunk.split('\n');
      const colored: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        // Detect code fence toggles
        if (line.trimStart().startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          colored.push(`${OUT_CODE_FENCE}${line}${OUT_RESET}`);
          continue;
        }

        // Skip lines that already have ANSI codes (e.g. ── @agent ── separators)
        if (ANSI_RE.test(line)) {
          colored.push(line);
        } else if (inCodeBlock) {
          // Code — bright white
          colored.push(`${OUT_CODE}${line}${OUT_RESET}`);
        } else {
          const isHeading = /^#{1,6}\s/.test(line);
          const stripped = stripMarkdown(line);
          if (isHeading) {
            colored.push(`${OUT_HEADING}${stripped}${OUT_RESET}`);
          } else {
            // Regular text — light gray
            colored.push(`${OUT_TEXT}${stripped}${OUT_RESET}`);
          }
        }
      }

      return colored.join('\n');
    },
  };
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

// ANSI helpers for the autocomplete menu
const MENU_INDIGO = '\x1b[38;5;105m';
const MENU_DIM = '\x1b[2m';
const MENU_HIGHLIGHT_BG = '\x1b[48;5;236m'; // dark gray bg for selected item
const MENU_RESET = '\x1b[0m';

const SLASH_MENU: Array<{ name: string; desc: string }> = [
  { name: '/agents',   desc: 'Enable/disable agents (/ag)' },
  { name: '/all',      desc: 'Run collaboration engine on all agents (/a)' },
  { name: '/worker',   desc: 'Set the worker adapter (/w)' },
  { name: '/model',    desc: 'View or change adapter models (/m)' },
  { name: '/new',      desc: 'Create a new session (/n)' },
  { name: '/threads',  desc: 'List & switch sessions (/t)' },
  { name: '/rename',   desc: 'Rename current session (/rn)' },
  { name: '/fork',     desc: 'Fork current session (/fk)' },
  { name: '/help',     desc: 'Show all commands & usage (/h)' },
  { name: '/status',   desc: 'Show adapter status (/st)' },
  { name: '/account',  desc: 'View account, plan & usage' },
  { name: '/upgrade',  desc: 'Open plan management in browser' },
  { name: '/login',    desc: 'Sign in to fixy.ai' },
  { name: '/logout',   desc: 'Sign out from fixy.ai' },
  { name: '/settings', desc: 'View or update global settings' },
  { name: '/red-room', desc: 'Toggle adversarial mode on/off' },
  { name: '/diff',      desc: 'Show git diff & untracked files (/d)' },
  { name: '/copy',      desc: 'Copy last response to clipboard' },
  { name: '/clear',     desc: 'Clear the terminal screen (/cls)' },
  { name: '/shortcuts', desc: 'Show keyboard shortcuts & commands' },
  { name: '/compact',   desc: 'Reset adapter session' },
  { name: '/reset',     desc: 'Abort current turn and reset all sessions' },
  { name: '/quit',      desc: 'Exit Fixy' },
];

export async function startRepl(params: ReplParams): Promise<void> {
  const { store, registry, worktreeManager, turnController, models } = params;
  let thread = params.thread;

  let turnActive = false;
  let turnAbort: AbortController | null = null;
  let spinner: ReturnType<typeof createSpinner> | null = null;
  let lastResponse = '';

  const settings = await loadSettings();
  const disabledAdapters = new Set(settings.disabledAdapters ?? []);
  const enabledAdapters = registry.list().filter((a) => !disabledAdapters.has(a.id));

  const allCompletions: string[] = [
    ...SLASH_MENU.map((m) => m.name),
    ...enabledAdapters.map((a) => `@${a.id}`),
    '@all',
    '@fixy',
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
    completer: (line: string): [string[], string] => {
      const lower = line.toLowerCase();
      const hits = allCompletions.filter((c) => c.toLowerCase().startsWith(lower));
      return [hits.length ? hits : [], line];
    },
  });

  // ── Autocomplete menus with arrow navigation (TTY only) ────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin, rl);

    const atMenu: Array<{ name: string; desc: string }> = [
      ...enabledAdapters.map((a) => ({
        name: `@${a.id}`,
        desc: `${a.name}${models[a.id] ? ` (${models[a.id]})` : ''}`,
      })),
      { name: '@all', desc: 'All agents collaborate' },
      { name: '@fixy', desc: 'Fixy worker / commands' },
    ];

    let menuHeight = 0;
    let menuItems: Array<{ name: string; desc: string }> = [];
    let selectedIndex = 0;
    let menuSelectionApplied = false; // flag: Enter applied a menu selection, skip line event

    const eraseMenu = (): void => {
      if (menuHeight === 0) return;
      let seq = '\x1b[s';
      for (let i = 0; i < menuHeight; i++) {
        seq += '\x1b[1B\x1b[2K';
      }
      seq += '\x1b[u';
      process.stdout.write(seq);
      menuHeight = 0;
      menuItems = [];
      selectedIndex = 0;
    };

    const drawMenu = (items: Array<{ name: string; desc: string }>, selIdx = 0): void => {
      eraseMenu();
      menuItems = items;
      selectedIndex = Math.min(selIdx, items.length - 1);
      const lines = items.map((item, i) => {
        const isSelected = i === selectedIndex;
        const bg = isSelected ? MENU_HIGHLIGHT_BG : '';
        const nameColor = isSelected ? MENU_INDIGO : MENU_DIM;
        const descColor = MENU_DIM;
        return `${bg}  ${nameColor}${item.name.padEnd(12)}${MENU_RESET}${bg}${descColor}${item.desc}${MENU_RESET}`;
      });
      process.stdout.write('\x1b[s\n' + lines.join('\n') + '\x1b[u');
      menuHeight = lines.length;
    };

    const applySelection = (fromEnter = false): void => {
      if (menuItems.length === 0) return;
      const selected = menuItems[selectedIndex];
      if (!selected) return;
      const line = rl.line;

      // Find the trigger token in the current line (last @ or leading /)
      const lastAt = line.lastIndexOf('@');
      const isSlash = line.startsWith('/');

      if (fromEnter) menuSelectionApplied = true;
      eraseMenu();
      // Clear current line and replace with selection
      process.stdout.write('\r\x1b[2K');
      if (isSlash) {
        rl.write(null, { ctrl: true, name: 'u' });
        rl.write(selected.name + ' ');
      } else if (lastAt >= 0) {
        const before = line.slice(0, lastAt);
        rl.write(null, { ctrl: true, name: 'u' });
        rl.write(before + selected.name + ' ');
      }
    };

    // Helper: find menu items matching a trigger
    const getFilteredMenu = (trigger: string, menu: Array<{ name: string; desc: string }>): Array<{ name: string; desc: string }> => {
      const lower = trigger.toLowerCase();
      return menu.filter((item) => item.name.toLowerCase().startsWith(lower));
    };

    process.stdin.on('keypress', (_str, key) => {
      if (key?.name === 'escape') {
        if (menuItems.length > 0) {
          eraseMenu();
          return;
        }
        if (turnActive && turnAbort) {
          turnAbort.abort();
          turnAbort = null;
          turnActive = false;
          spinner?.stop();
          spinner = null;
          process.stdout.write('\x1b[38;5;105mCancelled\x1b[0m\n');
        } else {
          eraseMenu();
          process.stdout.write('\r\x1b[2K');
        }
        return;
      }

      // Arrow navigation in menu
      if (menuItems.length > 0) {
        if (key?.name === 'down') {
          selectedIndex = (selectedIndex + 1) % menuItems.length;
          drawMenu(menuItems, selectedIndex);
          return;
        }
        if (key?.name === 'up') {
          selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
          drawMenu(menuItems, selectedIndex);
          return;
        }
        if (key?.name === 'return') {
          applySelection(true);
          return;
        }
        if (key?.name === 'tab') {
          applySelection();
          return;
        }
      }

      if (turnActive) {
        eraseMenu();
        return;
      }

      // Use setImmediate so readline has already updated rl.line before we read it.
      setImmediate(() => {
        const line = rl.line;

        // Detect inline @ anywhere in text (last @ token)
        const lastAt = line.lastIndexOf('@');
        const hasSlash = line.startsWith('/');

        if (hasSlash) {
          const lower = line.toLowerCase();
          const filtered = SLASH_MENU.filter((item) =>
            item.name.toLowerCase().startsWith(lower),
          );
          if (filtered.length > 0) {
            drawMenu(filtered);
          } else {
            eraseMenu();
          }
        } else if (lastAt >= 0) {
          const atToken = line.slice(lastAt);
          const afterAt = atToken.slice(1); // text after @
          // File path detection: starts with . or /
          if (afterAt.startsWith('.') || afterAt.startsWith('/')) {
            // Show file path hint instead of agent menu
            eraseMenu();
            drawMenu([{ name: '@<path>', desc: '(type file path, e.g. @./src/file.ts)' }]);
          } else {
            const lowerToken = atToken.toLowerCase();
            if (lowerToken === '@') {
              drawMenu(atMenu);
            } else {
              const filtered = getFilteredMenu(lowerToken, atMenu);
              if (filtered.length > 0) {
                drawMenu(filtered);
              } else {
                eraseMenu();
              }
            }
          }
        } else {
          eraseMenu();
        }
      });
    });

    rl.on('line', () => {
      eraseMenu();
      if (menuSelectionApplied) {
        menuSelectionApplied = false;
        // Re-show the prompt — the line event fired for the old input, ignore it
        rl.prompt();
      }
    });
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
      process.stdout.write('\x1b[38;5;105mCancelled\x1b[0m\n');
    } else {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      process.exit(0);
    }
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      const onClose = (): void => resolve(null);
      rl.once('close', onClose);
      rl.question(PROMPT, (answer) => {
        rl.removeListener('close', onClose);
        resolve(answer);
      });
    });

  const askChoice = (promptText: string, signal?: AbortSignal): Promise<string | null> =>
    new Promise((resolve) => {
      if (signal?.aborted) { resolve(null); return; }

      let settled = false;
      const settle = (val: string | null): void => {
        if (settled) return;
        settled = true;
        rl.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        resolve(val);
      };

      const onAbort = (): void => {
        // Inject a newline to flush readline's pending question cleanly.
        rl.write('\n');
        settle(null);
      };
      const onClose = (): void => settle(null);

      signal?.addEventListener('abort', onAbort, { once: true });
      rl.once('close', onClose);
      rl.question(promptText, (answer) => {
        settle(answer.trim());
      });
    });

  const resolveModelChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    // Extract adapter id from MODEL_SELECT @<id>
    const adapterMatch = msgContent.match(/^MODEL_SELECT @(\w+)/);
    const adapterId = adapterMatch?.[1] ?? thread.workerModel;

    // Parse model numbers from list
    const modelMatches = [...msgContent.matchAll(/\[(\d+)\]\s+([\w.-]+)/g)];
    const modelCount = modelMatches.length;
    const hasEffort = msgContent.includes('Effort (optional)');

    // Step 1: Pick model — number from list or type a name
    const modelPrompt = modelCount > 0
      ? `\x1b[38;5;105m[1-${modelCount}] or model name\x1b[0m `
      : `\x1b[38;5;105mmodel name\x1b[0m `;
    const pickModel = async (): Promise<string | null> => {
      for (;;) {
        const raw = await askChoice(modelPrompt, signal);
        if (raw === null) return null;
        const input = raw.trim();
        if (input.length === 0) return null;
        // Accept number (if we have a list)
        if (modelCount > 0) {
          const n = parseInt(input, 10);
          if (n >= 1 && n <= modelCount) return String(n);
        }
        // Accept typed model name directly (anything with a letter)
        if (/[a-zA-Z]/.test(input)) return input;
        if (modelCount > 0) {
          process.stdout.write(`Type a number [1-${modelCount}] or a model name\n`);
        } else {
          process.stdout.write('Type a model name\n');
        }
      }
    };
    const modelChoice = await pickModel();
    if (modelChoice === null) return null;

    // Step 2: Pick effort (Codex only)
    let effortLetter = '';
    if (hasEffort) {
      const effortRaw = await askChoice('\x1b[38;5;105m[a-d] effort or Enter to skip\x1b[0m ', signal);
      if (effortRaw === null) return null;
      const letter = effortRaw.trim().toLowerCase();
      if (/^[a-d]$/.test(letter)) effortLetter = letter;
    }

    // Step 3: Save globally?
    const saveRaw = await askChoice('\x1b[38;5;105mSave globally? (y/n)\x1b[0m ', signal);
    if (saveRaw === null) return null;
    const save = saveRaw.trim().toLowerCase() === 'y' ? 'y' : 'n';

    return `@fixy /model @${adapterId} apply ${modelChoice}${effortLetter} ${save}`;
  };

  const resolveAdapterToggle = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    const matches = [...msgContent.matchAll(/\[(\d+)\] @(\w+)/g)];
    const adapters = matches.map((m) => m[2] ?? '');
    if (adapters.length === 0) return null;
    const range = `1-${adapters.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}] or ESC to cancel\x1b[0m `, signal);
      if (choice === null || choice === '') return null;
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= adapters.length) return `@fixy /model @${adapters[n - 1]} toggle`;
      process.stdout.write(`Please type a number between ${range} or press Enter\n`);
    }
  };

  const resolveWorkerChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    const matches = [...msgContent.matchAll(/\[(\d+)\] @(\w+)/g)];
    const adapters = matches.map((m) => m[2] ?? '');
    if (adapters.length === 0) return null;
    const range = `1-${adapters.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}]\x1b[0m `, signal);
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
      const choice = await askChoice('\x1b[38;5;105m[1/2/3]\x1b[0m ', signal);
      if (choice === null) return null;
      if (choice === '1') return `@fixy Go with @${agentA}'s approach`;
      if (choice === '2') return `@fixy Go with @${agentB}'s approach`;
      if (choice === '3')
        return `@${agentA} @${agentB} Find a middle ground between both approaches`;
      process.stdout.write('Please type 1, 2, or 3\n');
    }
  };

  const resolveThreadChoice = async (msgContent: string, signal?: AbortSignal): Promise<string | null> => {
    // Parse thread ids from numbered list: [1] abcdef12… <full-id>
    const matches = [...msgContent.matchAll(/\[(\d+)\]\s+\w+…\s+([\w-]+)/g)];
    const threadIds = matches.map((m) => m[2] ?? '');
    if (threadIds.length === 0) return null;
    const range = `1-${threadIds.length}`;
    while (true) {
      const choice = await askChoice(`\x1b[38;5;105m[${range}] or ESC to cancel\x1b[0m `, signal);
      if (choice === null || choice === '') return null;
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= threadIds.length) return threadIds[n - 1] ?? null;
      process.stdout.write(`Please type a number between ${range} or press Enter\n`);
    }
  };

  const runTurn = async (input: string): Promise<void> => {
    turnAbort = new AbortController();
    turnActive = true;
    spinner = createSpinner();
    const colorizer = createColorizer();

    try {
      thread = await store.getThread(thread.id, thread.projectRoot);
      // Show spinner only when an external agent will respond (not for @fixy commands)
      const isFixyCommand = /^@fixy\s*\//.test(input);
      const isAllCommand = /@all\b/i.test(input) || /^@fixy\s+\/all\b/.test(input);
      if (!isFixyCommand && !isAllCommand) {
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
            // Skip the redundant @header for @all — it prints its own ── @agent ── separators
            if (!isAllCommand) {
              process.stdout.write(`\x1b[38;5;105m@${agentId ?? ''}\x1b[0m\n`);
            }
            headerPrinted = true;
          }
          process.stdout.write(colorizer.colorize(_stream, chunk));
        },
        signal: turnAbort.signal,
        worktreeManager,
      });

      thread = await store.getThread(thread.id, thread.projectRoot);

      // Track last agent response for /copy
      const lastAgentMsg = [...thread.messages].reverse().find((m) => m.role === 'agent');
      if (lastAgentMsg) lastResponse = lastAgentMsg.content;

      const lastMsg = thread.messages[thread.messages.length - 1];
      if (lastMsg && lastMsg.role === 'system') {
        // For interactive protocol messages, strip the first line (protocol keyword) before display.
        const PROTOCOL_PREFIXES = ['WORKER_SELECT', 'MODEL_SELECT', 'ADAPTER_TOGGLE_SELECT', 'THREAD_SELECT', 'THREAD_SWITCH', 'HELP'];
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

        if (lastMsg.content.startsWith('THREAD_SWITCH')) {
          // Auto-switch to the thread mentioned in the message (used by /fork)
          const switchMatch = lastMsg.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (switchMatch?.[1]) {
            const switchId = switchMatch[1];
            try {
              thread = await store.getThread(switchId, thread.projectRoot);
              process.stdout.write(`\x1b[38;5;105m✓\x1b[0m Switched to session ${switchId.slice(0, 8)}…\n`);
            } catch {
              // Thread not found — ignore, the message was already displayed
            }
          }
          return;
        }

        if (lastMsg.content.startsWith('THREAD_SELECT')) {
          const threadId = await resolveThreadChoice(lastMsg.content, interactiveSignal);
          if (threadId !== null) {
            thread = await store.getThread(threadId, thread.projectRoot);
            process.stdout.write(`\x1b[38;5;105m✓\x1b[0m Switched to session ${threadId.slice(0, 8)}…\n`);

            // Show last few messages as context
            const recent = thread.messages.slice(-6);
            if (recent.length > 0) {
              process.stdout.write(`\n\x1b[2m── recent history ──\x1b[0m\n`);
              for (const msg of recent) {
                if (msg.role === 'user') {
                  const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
                  process.stdout.write(`\x1b[37m  you: ${preview}\x1b[0m\n`);
                } else if (msg.role === 'agent' && msg.agentId) {
                  const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
                  process.stdout.write(`\x1b[2m  @${msg.agentId}: ${preview}\x1b[0m\n`);
                }
              }
              process.stdout.write(`\x1b[2m────────────────────\x1b[0m\n`);
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

    // Normalize: lowercase @mentions and /commands, preserve message body case
    const rawInput = line.trim();
    if (rawInput.length === 0) continue;

    // Shell command execution: !command
    if (rawInput.startsWith('!')) {
      const shellCmd = rawInput.slice(1).trim();
      if (shellCmd.length === 0) {
        process.stdout.write('\x1b[2musage: !<command>\x1b[0m\n');
        continue;
      }
      try {
        const { execSync } = await import('node:child_process');
        const output = execSync(shellCmd, {
          cwd: params.projectRoot,
          timeout: 30_000,
          encoding: 'utf8',
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        if (output) process.stdout.write(output);
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; status?: number; killed?: boolean };
        if (execErr.killed) {
          process.stdout.write('\x1b[2;31mCommand timed out\x1b[0m\n');
        } else {
          if (execErr.stderr) process.stdout.write(`\x1b[2;31m${execErr.stderr}\x1b[0m`);
          if (typeof execErr.status === 'number' && execErr.status !== 0) {
            process.stdout.write(`\x1b[2;31mExit code: ${execErr.status}\x1b[0m\n`);
          }
        }
      }
      continue;
    }

    // Lowercase @mentions and /commands for case-insensitive matching
    let normalized = rawInput
      .replace(/@\w+/g, (m) => m.toLowerCase())
      .replace(/^\/\w+/g, (m) => m.toLowerCase());

    // Auto-resolve partial /commands to first match (e.g. /qu → /quit, /a → /all)
    if (normalized.startsWith('/') && !normalized.includes(' ')) {
      const match = SLASH_MENU.find((item) => item.name.startsWith(normalized));
      if (match) normalized = match.name;
    }

    const input = normalized.startsWith('/') ? `@fixy ${normalized}` : normalized;

    if (normalized === '/quit' || normalized === '/exit') {
      process.stdout.write('\x1b[2mgoodbye\x1b[0m\n');
      break;
    }

    await runTurn(input);
  }

  rl.close();
  process.exit(0);
}
