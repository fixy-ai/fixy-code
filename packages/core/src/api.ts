import { loadAuth } from './auth.js';

const FIXY_API_BASE = 'https://fixy.ai/api/code';

// ── Helper ──

async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { isAuthExpired } = await import('./auth.js');
  const auth = await loadAuth();
  if (!auth?.token) {
    throw new Error('Not signed in. Run /login first.');
  }
  if (isAuthExpired(auth)) {
    throw new Error('Session expired. Run /login to sign in again.');
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.token}`,
    ...options.headers,
  };
  const res = await fetch(`${FIXY_API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    throw new Error('Session expired. Run /login to sign in again.');
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((body.message as string) ?? 'Access denied.');
  }
  return res;
}

// ── Profile ──

export interface CodeProfile {
  email: string;
  plan: string;
  limits: {
    activeThreads: number;
    projects: number;
    historyDays: number;
  };
  sessionsUsed: number;
  sessionsLimit: number;
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
  } | null;
}

export async function fetchProfile(): Promise<CodeProfile> {
  const res = await authedFetch('/me');
  if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`);
  return res.json() as Promise<CodeProfile>;
}

// ── Sessions ──

export interface CodeSession {
  id: string;
  projectPath: string;
  workerAgent: string | null;
  createdAt: string;
  lastActivity: string;
}

export async function registerSession(
  id: string,
  projectPath: string,
  workerAgent: string | null,
): Promise<CodeSession> {
  const res = await authedFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ id, projectPath, workerAgent }),
  });
  if (res.status === 403) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (body.error === 'SESSION_LIMIT_REACHED') {
      throw new Error(
        `Session limit reached (${(body.message as string) ?? 'upgrade your plan'}).`,
      );
    }
    throw new Error((body.message as string) ?? 'Session registration denied.');
  }
  if (!res.ok) throw new Error(`Session registration failed: ${res.status}`);
  const data = await res.json() as { session: CodeSession };
  return data.session;
}

export async function heartbeat(sessionId: string): Promise<void> {
  await authedFetch(`/sessions/${sessionId}/activity`, { method: 'PUT' });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await authedFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function listSessions(): Promise<{ sessions: CodeSession[]; total: number }> {
  const res = await authedFetch('/sessions');
  if (!res.ok) throw new Error(`Session list failed: ${res.status}`);
  return res.json() as Promise<{ sessions: CodeSession[]; total: number }>;
}

// ── Plans ──

export interface CodePlan {
  id: string;
  name: string;
  price: number;
  features: Record<string, unknown>;
}

export async function fetchPlans(): Promise<CodePlan[]> {
  const res = await fetch(`${FIXY_API_BASE}/plans`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Plans fetch failed: ${res.status}`);
  return res.json() as Promise<CodePlan[]>;
}

// ── Usage ──

export async function fetchUsage(days = 30): Promise<Record<string, unknown>> {
  const res = await authedFetch(`/usage?days=${days}`);
  if (!res.ok) throw new Error(`Usage fetch failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}
