import os from 'node:os';
import path from 'node:path';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const FIXY_COLOR = '\x1b[38;5;105m';

const COLORS: Record<string, string> = {
  claude: '\x1b[34m',
  codex: '\x1b[32m',
  fixy: FIXY_COLOR,
  system: DIM,
};

export function agentColor(agentId: string): (text: string) => string {
  const code = COLORS[agentId];
  if (!code) return (text: string) => text;
  return (text: string) => `${code}${text}${RESET}`;
}

export function formatPrefix(agentId: string): string {
  return agentColor(agentId)(`[${agentId}]`);
}

export const PROMPT = `${FIXY_COLOR}❯${RESET}  `;

export function startupPanel(
  version: string,
  adapters: string[],
  models: Record<string, string | null>,
  projectRoot: string,
  threadId: string,
  worker: string,
  authInfo?: { email: string; plan: string } | null,
): string {
  const cols = Math.max(Math.min(process.stdout.columns ?? 80, 80), 52);
  const innerWidth = cols - 2;

  const homeDir = os.homedir();
  const rel = path.relative(homeDir, projectRoot);
  const dirDisplay = rel.startsWith('..') ? projectRoot : `~/${rel}`;

  const agentDisplay = adapters
    .map((a) => {
      const model = models[a];
      return model ? `@${a} (${model})` : `@${a}`;
    })
    .join(' · ');

  const contentLines: string[] = [
    `${BOLD}${FIXY_COLOR}Fixy v${version}${RESET}`,
    `${DIM}Agents: ${agentDisplay}${RESET}`,
    `${DIM}Worker: @${worker}${models[worker] ? ` (${models[worker]})` : ''}${RESET}`,
    `${DIM}Directory: ${dirDisplay}${RESET}`,
    `${DIM}Thread: ${threadId}${RESET}`,
    authInfo
      ? `${DIM}Account: ${authInfo.email} (${authInfo.plan})${RESET}`
      : `${DIM}Account: free · /login to sign in${RESET}`,
  ];

  const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

  const padLine = (line: string): string => {
    const vl = visibleLen(line);
    const available = innerWidth - 2; // 1 space on each side
    const spaces = Math.max(0, available - vl);
    return `${FIXY_COLOR}│${RESET} ${line}${' '.repeat(spaces)} ${FIXY_COLOR}│${RESET}`;
  };

  const top = `${FIXY_COLOR}╭${'─'.repeat(innerWidth)}╮${RESET}`;
  const bottom = `${FIXY_COLOR}╰${'─'.repeat(innerWidth)}╯${RESET}`;

  const hints = `${DIM}  @ mention agents · / commands · Tab complete · ESC cancel · Ctrl-C quit${RESET}`;

  return [top, ...contentLines.map(padLine), bottom, hints].join('\n');
}

export function createSpinner(): { start(label: string): void; stop(): void } {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;

  if (!process.stdout.isTTY) {
    return {
      start: (_label: string) => {},
      stop: () => {},
    };
  }

  return {
    start(label: string): void {
      frameIndex = 0;
      intervalId = setInterval(() => {
        const frame = frames[frameIndex % frames.length] ?? frames[0] ?? '⠋';
        process.stdout.write(`\r${FIXY_COLOR}${frame}${RESET} ${label}`);
        frameIndex++;
      }, 100);
    },
    stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      process.stdout.write('\r\x1b[2K');
    },
  };
}
