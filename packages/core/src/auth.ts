import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { authPath } from './paths.js';

const FIXY_API_BASE = 'https://fixy.ai/api/code';

export interface FixyAuth {
  token: string;
  email: string;
  plan: string;
  expiresAt: string | null;
}

export async function loadAuth(): Promise<FixyAuth | null> {
  const path = authPath();
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as FixyAuth;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveAuth(auth: FixyAuth): Promise<void> {
  const path = authPath();
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(auth, null, 2), 'utf8');
  await rename(tmpPath, path);
}

export async function clearAuth(): Promise<void> {
  const path = authPath();
  try {
    await rm(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

/** Request a device code from the Fixy API for terminal-to-web auth. */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${FIXY_API_BASE}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<DeviceCodeResponse>;
}

export interface PollResult {
  status: 'pending' | 'authorized' | 'expired';
  auth?: FixyAuth;
}

/** Poll the Fixy API for device code authorization status. */
export async function pollDeviceAuth(deviceCode: string): Promise<PollResult> {
  const res = await fetch(`${FIXY_API_BASE}/auth/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });
  if (!res.ok) {
    throw new Error(`Poll request failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<PollResult>;
}

/**
 * Run the full device auth flow: request code, show URL, poll until authorized.
 * Returns the auth object on success, null if expired/cancelled.
 */
export async function runDeviceAuthFlow(
  onStatus: (msg: string) => void,
  signal?: AbortSignal,
): Promise<FixyAuth | null> {
  const device = await requestDeviceCode();

  onStatus(`\nOpen this URL in your browser:\n`);
  onStatus(`  ${device.verificationUrl}?code=${device.userCode}\n\n`);
  onStatus(`Your code: ${device.userCode}\n`);
  onStatus(`Waiting for authorization...\n`);

  const deadline = Date.now() + device.expiresIn * 1000;
  const interval = Math.max(device.interval, 5) * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) return null;

    await new Promise((resolve) => setTimeout(resolve, interval));

    if (signal?.aborted) return null;

    try {
      const result = await pollDeviceAuth(device.deviceCode);
      if (result.status === 'authorized' && result.auth) {
        await saveAuth(result.auth);
        return result.auth;
      }
      if (result.status === 'expired') {
        return null;
      }
    } catch {
      // Network error during poll — keep trying until deadline
    }
  }

  return null;
}
