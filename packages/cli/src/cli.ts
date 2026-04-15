#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LocalThreadStore, AdapterRegistry, TurnController, WorktreeManager, loadSettings, saveSettings, settingsPath, runDeviceAuthFlow, loadAuth, saveAuth, isAuthExpired, clearAuth, fetchProfile, registerSession } from '@fixy/core';
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
      `${INDIGO}  ℹ  Fixy v${remoteVersion} Available — Update Now? (Y/n) ${RESET}`,
    );

    const answer = await new Promise<string>((resolve) => {
      if (!process.stdin.isTTY) { resolve('n'); return; }
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', (buf) => {
        const key = buf.toString().toLowerCase();
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(key);
      });
    });

    // Y/y or Enter (raw mode sends \r) = yes, anything else = no
    const accepted = answer === 'y' || answer === '\r';
    process.stdout.write(`${accepted ? 'y' : 'n'}\n`);

    if (!accepted) return;

    process.stdout.write(`${DIM}  updating…${RESET}\n`);
    // Safe: commands are hardcoded literals, no user input involved
    const { execSync, spawnSync } = await import('node:child_process');
    try {
      execSync('npm install -g @fixy/code --registry https://registry.npmjs.org', { stdio: 'inherit' });
      process.stdout.write(`${INDIGO}  ✓  Updated to v${remoteVersion} — Fixy is restarting…${RESET}\n`);
      // Destroy stdin to clean up event listeners before spawning child process
      process.stdin.destroy();
      // Resolve the real script path from the freshly installed package (follow symlinks)
      const binPath = execSync('which fixy', { encoding: 'utf8' }).trim() || 'fixy';
      const realPath = execSync(`realpath "${binPath}"`, { encoding: 'utf8' }).trim();
      // Re-launch via node directly to avoid any module caching
      spawnSync(process.execPath, [realPath, '--skip-update-check', ...process.argv.slice(2)], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    } catch {
      process.stdout.write(`\x1b[31m  ✗  Update failed — run: npm install -g @fixy/code${RESET}\n`);
    }
    process.exit(0);
  } catch {
    // fetch failed, timed out, or versions match — stay silent
  }
}

async function runOnboarding(registry: AdapterRegistry): Promise<void> {
  const INDIGO = '\x1b[38;5;105m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  process.stdout.write(`\n${BOLD}${INDIGO}Welcome to Fixy!${RESET}\n\n`);
  process.stdout.write(`${DIM}For more info: https://fixy.ai/code${RESET}\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const askNumber = (prompt: string, max: number): Promise<number> =>
    new Promise((resolve) => {
      const ask = (): void => {
        rl.question(prompt, (ans) => {
          const n = parseInt(ans.trim(), 10);
          if (n >= 1 && n <= max) resolve(n);
          else ask();
        });
      };
      ask();
    });

  const askYN = (prompt: string): Promise<boolean> =>
    new Promise((resolve) => {
      const ask = (): void => {
        rl.question(prompt, (ans) => {
          const v = ans.trim().toLowerCase();
          if (v === 'y') resolve(true);
          else if (v === 'n') resolve(false);
          else ask();
        });
      };
      ask();
    });

  // Step 0 — Free or Sign In
  process.stdout.write(`${BOLD}Step 1 — Choose your plan${RESET}\n`);
  process.stdout.write(`  ${INDIGO}1${RESET}  Free — start using Fixy right away\n`);
  process.stdout.write(`  ${INDIGO}2${RESET}  Sign In — unlock more features\n\n`);

  const planChoice = await askNumber(`${INDIGO}Choose [1-2]:${RESET} `, 2);

  if (planChoice === 2) {
    process.stdout.write(`\n${DIM}Starting sign-in…${RESET}\n`);
    try {
      const auth = await runDeviceAuthFlow((msg: string) => process.stdout.write(msg));
      if (auth) {
        process.stdout.write(`\n${INDIGO}✓${RESET}  Signed in as ${auth.email} (${auth.plan} plan)\n\n`);
      } else {
        process.stdout.write(`\n${DIM}Sign-in skipped. You can sign in later with /login${RESET}\n\n`);
      }
    } catch {
      process.stdout.write(`\n${DIM}Sign-in failed. You can try again later with /login${RESET}\n\n`);
    }
  } else {
    process.stdout.write(`\n${DIM}Using free plan. Sign in anytime with /login${RESET}\n\n`);
  }

  // Step 2 — Claude permissions
  process.stdout.write(`${BOLD}Step 2 — Claude permissions${RESET}\n`);
  process.stdout.write(
    `${DIM}By default, Claude asks for your approval before making file changes.\n` +
    `You can turn this off so Claude works without interruptions.\n` +
    `You can always change this later with: @fixy /settings set claudeArgs${RESET}\n\n`,
  );
  const skipPerms = await askYN(`${INDIGO}Let Claude work without asking for approval each time? (y/n):${RESET} `);

  // Step 2 — default worker
  const adapterList = registry.list();
  process.stdout.write(`\n${BOLD}Step 3 — Default worker${RESET}\n`);
  process.stdout.write(
    `${DIM}Your worker is the AI agent that responds when you type a message\n` +
    `without an @mention. You can change it any time with: @fixy /worker <agent>${RESET}\n\n`,
  );
  process.stdout.write(`${INDIGO}Available agents:${RESET}\n`);
  adapterList.forEach((a, i) => {
    process.stdout.write(`  ${INDIGO}${i + 1}${RESET}  @${a.id}\n`);
  });
  const workerIdx = await askNumber(
    `\n${INDIGO}Choose default worker [1-${adapterList.length}]:${RESET} `,
    adapterList.length,
  );
  const chosenAdapter = adapterList[workerIdx - 1];
  if (!chosenAdapter) throw new Error(`Invalid worker selection: ${workerIdx}`);
  const chosenWorker = chosenAdapter.id;

  // Step 3 — model for the chosen worker
  let chosenModel = '';
  if (typeof chosenAdapter.listModels === 'function') {
    const modelList = await chosenAdapter.listModels();
    if (modelList.length > 0) {
      process.stdout.write(`\n${BOLD}Step 4 — ${chosenAdapter.name} model${RESET}\n`);
      process.stdout.write(`${DIM}Which model should @${chosenWorker} use?${RESET}\n\n`);
      modelList.forEach((m, i) => {
        const desc = m.description ? `  ${DIM}${m.description}${RESET}` : '';
        process.stdout.write(`  ${INDIGO}${i + 1}${RESET}  ${m.id}${desc}\n`);
      });
      const modelIdx = await askNumber(
        `\n${INDIGO}Choose model [1-${modelList.length}]:${RESET} `,
        modelList.length,
      );
      chosenModel = modelList[modelIdx - 1]?.id ?? '';
    }
  }

  rl.close();

  const settings = await loadSettings();
  settings.defaultWorker = chosenWorker;
  if (skipPerms) settings.claudeArgs = '--dangerously-skip-permissions';
  if (chosenModel) {
    if (chosenWorker === 'claude') settings.claudeModel = chosenModel;
    else if (chosenWorker === 'codex') settings.codexModel = chosenModel;
    else if (chosenWorker === 'gemini') settings.geminiModel = chosenModel;
  }
  await saveSettings(settings);

  process.stdout.write(
    `\n${INDIGO}✓${RESET}  All set! Worker: @${chosenWorker}${chosenModel ? ` (${chosenModel})` : ''}\n\n`,
  );
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
  let skipUpdateCheck = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--thread' && args[i + 1]) {
      threadId = args[++i];
    } else if (args[i] === '--skip-update-check') {
      skipUpdateCheck = true;
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
  // First-run onboarding: show wizard if settings.json doesn't exist yet.
  const isFirstRun = !existsSync(settingsPath());
  if (isFirstRun) {
    await runOnboarding(registry);
  }

  const settings = await loadSettings();

  // Collect active model names: prefer Fixy settings, fallback to adapter detection.
  const adapterList = registry.list();
  const fixyModels: Record<string, string> = {
    claude: settings.claudeModel,
    codex: settings.codexModel,
    gemini: settings.geminiModel,
  };
  const modelEntries = await Promise.all(
    adapterList.map(async (a) => {
      const fixyModel = fixyModels[a.id]?.trim() || null;
      if (fixyModel) return [a.id, fixyModel] as [string, string | null];
      const model =
        typeof a.getActiveModel === 'function' ? await a.getActiveModel() : null;
      return [a.id, model] as [string, string | null];
    }),
  );
  const models: Record<string, string | null> = Object.fromEntries(modelEntries);

  const thread = threadId
    ? await store.getThread(threadId, projectRoot)
    : await store.createThread(projectRoot);

  // Thread worker defaults to settings.defaultWorker on creation; keep in sync.
  const currentWorker = thread.workerModel ?? settings.defaultWorker;

  // Start update check early so the network request runs while we render the panel.
  const updateCheck = skipUpdateCheck ? Promise.resolve() : checkForUpdate(version);

  let auth = await loadAuth();

  // Check token expiry on startup
  if (auth && isAuthExpired(auth)) {
    process.stdout.write('\x1b[2mSession expired. Run /login to sign in again.\x1b[0m\n');
    await clearAuth();
    auth = null;
  }

  // Sync plan from server (non-blocking)
  if (auth) {
    fetchProfile()
      .then(async (profile) => {
        if (auth && profile.plan !== auth.plan) {
          auth.plan = profile.plan;
          await saveAuth(auth);
        }
      })
      .catch(() => {});
  }

  // Register session with backend (fire-and-forget)
  if (auth) {
    registerSession(thread.id, projectRoot, thread.workerModel ?? null)
      .catch(() => {});
  }

  const authInfo = auth ? { email: auth.email, plan: auth.plan } : null;

  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');

  process.stdout.write(
    startupPanel(
      version,
      registry.list().map((a) => a.id),
      models,
      projectRoot,
      thread.id,
      currentWorker,
      authInfo,
      thread.name,
      settings.workerModelOverride || undefined,
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
