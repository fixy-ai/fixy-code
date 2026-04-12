import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024; // 4MB cap per stream

const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;

/** Claude Code nesting-guard env vars that prevent nested spawns from starting. */
const CLAUDE_NESTING_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_PARENT_SESSION',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunChildOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  onSpawn?: (pid: number) => void;
  timeoutMs?: number;
}

export interface RunChildResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Appends `chunk` to `prev`, keeping the combined string within `cap` bytes.
 * When the cap is exceeded the oldest bytes are dropped (tail is preserved).
 */
export function appendWithCap(
  prev: string,
  chunk: string,
  cap = MAX_CAPTURE_BYTES,
): string {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

function stripClaudeNestingVars(
  env: Record<string, string>,
): Record<string, string> {
  const result = { ...env };
  for (const key of CLAUDE_NESTING_VARS) {
    delete result[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Builds an env record that inherits from `process.env`, ensures critical
 * keys (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH`) are preserved
 * untouched from the current process, strips Claude Code nesting-guard vars,
 * and finally layers caller-supplied `overrides` on top.
 */
export function buildInheritedEnv(
  overrides?: Record<string, string>,
): Record<string, string> {
  // Start from process.env, filtering out undefined values.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      base[k] = v;
    }
  }

  // Restore critical keys from process.env (no-op if already present, but
  // ensures overrides cannot accidentally clobber them before we re-pin).
  const pinKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PATH'] as const;
  for (const key of pinKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      base[key] = val;
    }
  }

  // Strip nesting guards so spawned Claude processes don't refuse to start.
  const stripped = stripClaudeNestingVars(base);

  // Layer caller overrides on top (they cannot override pinned keys because
  // we re-pin below).
  const merged = { ...stripped, ...(overrides ?? {}) };

  // Re-pin critical keys so overrides cannot change them.
  for (const key of pinKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      merged[key] = val;
    }
  }

  return merged;
}

/**
 * Ensures the env record has a non-empty `PATH`.
 * If it is already set, returns the record unchanged.
 * Otherwise injects a sensible macOS/Linux default.
 */
export function ensurePathInEnv(
  env: Record<string, string>,
): Record<string, string> {
  if (env['PATH'] && env['PATH'].length > 0) {
    return env;
  }
  return {
    ...env,
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
}

/**
 * Returns a shallow copy of `env` where any key matching `SENSITIVE_ENV_KEY`
 * has its value replaced with `'***REDACTED***'`.
 */
export function redactEnvForLogs(
  env: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = SENSITIVE_ENV_KEY.test(k) ? '***REDACTED***' : v;
  }
  return result;
}

/**
 * Resolves the absolute path of `command` using `which` (or `where` on
 * Windows). Throws if the command is not found.
 */
export async function resolveCommand(command: string): Promise<string> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(whichCmd, [command]);
    return stdout.trim();
  } catch {
    throw new Error(`Command not found: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Core child-process runner
// ---------------------------------------------------------------------------

/**
 * Spawns a child process and captures its output.
 *
 * - Inherits env via `ensurePathInEnv({ ...process.env, ...opts.env })` with
 *   Claude nesting vars stripped.
 * - Captures up to `MAX_CAPTURE_BYTES` of stdout/stderr each.
 * - Streams data to `opts.onLog` in real time.
 * - Supports optional `AbortSignal` and timeout.
 */
export function runChildProcess(opts: RunChildOpts): Promise<RunChildResult> {
  return new Promise((resolve, reject) => {
    // Merge env: process.env base, then caller overrides, then ensure PATH.
    const rawEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) rawEnv[k] = v;
    }
    const mergedEnv = ensurePathInEnv(
      stripClaudeNestingVars({ ...rawEnv, ...opts.env }),
    );

    const stdinMode = opts.stdin != null ? 'pipe' : 'ignore';

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: mergedEnv,
      stdio: [stdinMode, 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let settled = false;

    // -----------------------------------------------------------------------
    // stdin
    // -----------------------------------------------------------------------
    if (opts.stdin != null && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    // -----------------------------------------------------------------------
    // onSpawn
    // -----------------------------------------------------------------------
    child.on('spawn', () => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        opts.onSpawn?.(child.pid);
      }
    });

    // -----------------------------------------------------------------------
    // stdout / stderr capture
    // -----------------------------------------------------------------------
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf = appendWithCap(stdoutBuf, text);
      opts.onLog?.('stdout', text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf = appendWithCap(stderrBuf, text);
      opts.onLog?.('stderr', text);
    });

    // -----------------------------------------------------------------------
    // Kill helper (SIGTERM → SIGKILL after 5 s)
    // -----------------------------------------------------------------------
    function killChild(): void {
      try {
        // Negative PID kills the entire process group (detached: true).
        if (typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Process may have already exited — ignore.
      }

      setTimeout(() => {
        try {
          if (typeof child.pid === 'number') {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // Ignore.
        }
      }, 5_000).unref();
    }

    // -----------------------------------------------------------------------
    // AbortSignal support
    // -----------------------------------------------------------------------
    let abortListener: (() => void) | undefined;
    if (opts.signal) {
      abortListener = () => {
        if (!settled) killChild();
      };
      if (opts.signal.aborted) {
        // Already aborted before spawn.
        killChild();
      } else {
        opts.signal.addEventListener('abort', abortListener);
      }
    }

    // -----------------------------------------------------------------------
    // Timeout support
    // -----------------------------------------------------------------------
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs != null && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          killChild();
        }
      }, opts.timeoutMs);
    }

    // -----------------------------------------------------------------------
    // close / error
    // -----------------------------------------------------------------------
    child.on(
      'close',
      (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        settled = true;

        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (abortListener && opts.signal) {
          opts.signal.removeEventListener('abort', abortListener);
        }

        resolve({
          exitCode,
          signal: exitSignal,
          timedOut,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      },
    );

    child.on('error', (err: Error) => {
      settled = true;

      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener && opts.signal) {
        opts.signal.removeEventListener('abort', abortListener);
      }

      reject(
        new Error(
          `Failed to spawn "${opts.command}": ${err.message}`,
          { cause: err },
        ),
      );
    });
  });
}
