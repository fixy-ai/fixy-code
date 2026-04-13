import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Returns the Fixy home directory. Respects FIXY_HOME env var for testing. */
export function getFixyHome(): string {
  return process.env['FIXY_HOME'] ?? join(homedir(), '.fixy');
}

/** Returns the path to the global config file. */
export function getConfigPath(): string {
  return join(getFixyHome(), 'config.json');
}

/** Computes the project id (sha1 hex digest of the absolute projectRoot). */
export function computeProjectId(projectRoot: string): string {
  return createHash('sha1').update(projectRoot).digest('hex');
}

/** Returns the project directory for a given projectRoot. */
export function getProjectDir(projectRoot: string): string {
  return join(getFixyHome(), 'projects', computeProjectId(projectRoot));
}

/** Returns the project.json path for a given projectRoot. */
export function getProjectFile(projectRoot: string): string {
  return join(getProjectDir(projectRoot), 'project.json');
}

/** Returns the threads directory for a given projectRoot. */
export function getThreadsDir(projectRoot: string): string {
  return join(getProjectDir(projectRoot), 'threads');
}

/** Returns the full path to a thread JSON file. */
export function getThreadFile(projectRoot: string, threadId: string): string {
  return join(getThreadsDir(projectRoot), `${threadId}.json`);
}

/** Returns the worktrees directory for a given threadId. */
export function getWorktreesDir(threadId: string): string {
  return join(getFixyHome(), 'worktrees', threadId);
}

/** Returns the path to the global settings file (~/.fixy/settings.json). */
export function settingsPath(): string {
  return join(getFixyHome(), 'settings.json');
}

/** Returns the path to the auth token file (~/.fixy/auth.json). */
export function authPath(): string {
  return join(getFixyHome(), 'auth.json');
}
