import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { settingsPath } from './paths.js';

export interface FixySettings {
  defaultWorker: string;
  collaborationMode: 'standard' | 'critics' | 'red_room' | 'consensus';
  redRoomMode: boolean;
  reviewMode: 'auto' | 'ask_me' | 'manual';
  maxDiscussionRounds: number;
  maxReviewRounds: number;
  maxTodosPerBatch: number;
  workerCount: number;
  claudeArgs: string;
  codexArgs: string;
  geminiArgs: string;
  claudeModel: string;
  codexModel: string;
  codexEffort: string;
  geminiModel: string;
  disabledAdapters: string[];
}

export const defaultSettings: FixySettings = {
  defaultWorker: 'claude',
  collaborationMode: 'standard',
  redRoomMode: false,
  reviewMode: 'auto',
  maxDiscussionRounds: 3,
  maxReviewRounds: 2,
  maxTodosPerBatch: 5,
  workerCount: 1,
  claudeArgs: '',
  codexArgs: '',
  geminiArgs: '',
  claudeModel: '',
  codexModel: '',
  codexEffort: '',
  geminiModel: '',
  disabledAdapters: [],
};

export async function loadSettings(): Promise<FixySettings> {
  const path = settingsPath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FixySettings>;
    return { ...defaultSettings, ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...defaultSettings };
    }
    throw err;
  }
}

export async function saveSettings(s: FixySettings): Promise<void> {
  const path = settingsPath();
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(s, null, 2), 'utf8');
  await rename(tmpPath, path);
}
