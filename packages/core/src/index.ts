export type { FixyRole, FixyThread, FixyMessage, FixyPatch } from './thread.js';

export type {
  FixyAgent,
  FixyThreadContext,
  FixyExecutionContext,
  FixyExecutionResult,
  FixySession,
  FixyInvocationMeta,
  FixyAdapter,
  FixyProbeResult,
} from './adapter.js';

export {
  getFixyHome,
  getConfigPath,
  computeProjectId,
  getProjectDir,
  getProjectFile,
  getThreadsDir,
  getThreadFile,
  getWorktreesDir,
} from './paths.js';

export { LocalThreadStore } from './store.js';

export { AdapterRegistry } from './registry.js';

export { Router } from './router.js';
export type { ParsedInput } from './router.js';

export { TurnController } from './turn.js';
export type { TurnParams } from './turn.js';

export { WorktreeManager } from './worktree.js';
export type { WorktreeHandle } from './worktree.js';
export { parseUnifiedDiff } from './diff-parser.js';

export { FixyCommandRunner } from './fixy-commands.js';
export type { FixyCommandContext } from './fixy-commands.js';

export { slugify } from './slugify.js';
