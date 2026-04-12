const RESET = '\x1b[0m';

const COLORS: Record<string, string> = {
  claude: '\x1b[34m',
  codex: '\x1b[32m',
  fixy: '\x1b[33m',
  system: '\x1b[2m',
};

export function agentColor(agentId: string): (text: string) => string {
  const code = COLORS[agentId];
  if (!code) return (text: string) => text;
  return (text: string) => `${code}${text}${RESET}`;
}

export function formatPrefix(agentId: string): string {
  return agentColor(agentId)(`[${agentId}]`);
}

export function banner(version: string, adapters: string[]): string {
  const adapterList = adapters.map((a) => `@${a}`).join(', ');
  const text = `fixy v${version} — ${adapterList} ready`;
  return agentColor('fixy')(text);
}
