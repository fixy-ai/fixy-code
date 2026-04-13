import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultSettings, loadSettings, saveSettings } from '../settings.js';
import { settingsPath } from '../paths.js';
import { FixyCommandRunner } from '../fixy-commands.js';
import type { FixyCommandContext } from '../fixy-commands.js';
import { AdapterRegistry } from '../registry.js';
import { LocalThreadStore } from '../store.js';
import type { WorktreeManager } from '../worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubWorktreeManager = {
  ensure: async () => ({ path: '', branch: '', agentId: '', threadId: '' }),
  collectPatches: async () => [],
  reset: async () => {},
  remove: async () => {},
  list: async () => [],
} as unknown as WorktreeManager;

// ---------------------------------------------------------------------------
// loadSettings / saveSettings
// ---------------------------------------------------------------------------

describe('loadSettings / saveSettings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fixy-settings-test-'));
    process.env['FIXY_HOME'] = tmpDir;
  });

  afterEach(async () => {
    delete process.env['FIXY_HOME'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when settings file is missing', async () => {
    const settings = await loadSettings();
    expect(settings).toEqual(defaultSettings);
  });

  it('set persists and reloads correctly', async () => {
    const modified = { ...defaultSettings, defaultWorker: 'codex', maxDiscussionRounds: 7 };
    await saveSettings(modified);

    const reloaded = await loadSettings();
    expect(reloaded.defaultWorker).toBe('codex');
    expect(reloaded.maxDiscussionRounds).toBe(7);
  });

  it('merges missing keys with defaults when file has partial data', async () => {
    const path = settingsPath();
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ defaultWorker: 'codex' }), 'utf8');

    const settings = await loadSettings();
    expect(settings.defaultWorker).toBe('codex');
    expect(settings.maxDiscussionRounds).toBe(defaultSettings.maxDiscussionRounds);
    expect(settings.collaborationMode).toBe(defaultSettings.collaborationMode);
  });

  it('reset restores defaults', async () => {
    // First save modified settings
    await saveSettings({ ...defaultSettings, defaultWorker: 'codex', workerCount: 3 });

    // Then reset by saving defaults
    await saveSettings({ ...defaultSettings });

    const reloaded = await loadSettings();
    expect(reloaded).toEqual(defaultSettings);
  });

  it('saveSettings writes valid JSON to the settings path', async () => {
    await saveSettings({ ...defaultSettings });
    const raw = await readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(defaultSettings);
  });
});

// ---------------------------------------------------------------------------
// /settings command (via FixyCommandRunner)
// ---------------------------------------------------------------------------

describe('/settings command', () => {
  let tmpDir: string;
  let store: LocalThreadStore;
  let runner: FixyCommandRunner;
  let ctx: FixyCommandContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fixy-settings-cmd-test-'));
    process.env['FIXY_HOME'] = tmpDir;
    store = new LocalThreadStore();
    await store.init();
    const thread = await store.createThread('/tmp/fake-project');
    const registry = new AdapterRegistry();
    runner = new FixyCommandRunner();
    ctx = {
      thread,
      rest: '',
      store,
      registry,
      worktreeManager: stubWorktreeManager,
      onLog: () => {},
      signal: AbortSignal.timeout(5000),
    };
  });

  afterEach(async () => {
    delete process.env['FIXY_HOME'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('/settings prints all key/value pairs', async () => {
    await runner.run({ ...ctx, rest: '/settings' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.role).toBe('system');
    const content = sysMsg?.content ?? '';
    expect(content).toContain('defaultWorker:');
    expect(content).toContain('collaborationMode:');
    expect(content).toContain('maxDiscussionRounds:');
  });

  it('/settings set <key> <value> persists the new value', async () => {
    await runner.run({ ...ctx, rest: '/settings set defaultWorker codex' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.content).toBe('defaultWorker set to codex');

    const settings = await loadSettings();
    expect(settings.defaultWorker).toBe('codex');
  });

  it('/settings set parses boolean correctly', async () => {
    await runner.run({ ...ctx, rest: '/settings set redRoomMode true' });

    const settings = await loadSettings();
    expect(settings.redRoomMode).toBe(true);
  });

  it('/settings set parses number correctly', async () => {
    await runner.run({ ...ctx, rest: '/settings set maxDiscussionRounds 8' });

    const settings = await loadSettings();
    expect(settings.maxDiscussionRounds).toBe(8);
  });

  it('/settings set invalid key is rejected without writing', async () => {
    // Ensure file doesn't exist yet
    const pathBefore = settingsPath();
    const existsBefore = await readFile(pathBefore, 'utf8').then(() => true).catch(() => false);

    await runner.run({ ...ctx, rest: '/settings set nonExistentKey someValue' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.content).toContain('unknown settings key');
    expect(sysMsg?.content).toContain('nonExistentKey');

    // File should not have been written (still same state as before)
    const existsAfter = await readFile(pathBefore, 'utf8').then(() => true).catch(() => false);
    expect(existsAfter).toBe(existsBefore);
  });

  it('/settings reset restores defaults', async () => {
    // First set something
    await saveSettings({ ...defaultSettings, defaultWorker: 'codex' });

    await runner.run({ ...ctx, rest: '/settings reset' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.content).toBe('settings reset to defaults');

    const settings = await loadSettings();
    expect(settings).toEqual(defaultSettings);
  });

  it('/settings set missing value shows usage', async () => {
    await runner.run({ ...ctx, rest: '/settings set defaultWorker' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.content).toContain('usage:');
  });

  it('/settings unknown subcommand shows usage', async () => {
    await runner.run({ ...ctx, rest: '/settings foobar' });

    const fresh = await store.getThread(ctx.thread.id, ctx.thread.projectRoot);
    const sysMsg = fresh.messages.at(-1);
    expect(sysMsg?.content).toContain('usage:');
  });
});
