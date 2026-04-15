import { execSync } from 'node:child_process';
import type { FixyAdapter } from './adapter.js';

export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'LOW';

export interface CodeIssue {
  severity: IssueSeverity;
  file: string;
  line: number | null;
  description: string;
  agentId: string;
}

export interface ReviewResult {
  issues: CodeIssue[];
  approved: boolean;
  warnings: string[];
}

const EXEC_OPTIONS = { encoding: 'utf-8' as const, maxBuffer: 10 * 1024 * 1024 };
const MAX_DIFF_BYTES = 50 * 1024;

function runGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { ...EXEC_OPTIONS, cwd });
  } catch {
    return '';
  }
}

export async function collectGitDiff(projectRoot: string, stagedOnly?: boolean): Promise<string> {
  let output = '';

  if (stagedOnly) {
    output += runGit('diff --staged', projectRoot);
  } else {
    output += runGit('diff', projectRoot);
    output += runGit('diff --staged', projectRoot);
  }

  const untracked = runGit('ls-files --others --exclude-standard', projectRoot);
  if (untracked.trim()) {
    output += `\nUntracked files:\n${untracked}`;
  }

  const totalBytes = Buffer.byteLength(output, 'utf-8');
  if (totalBytes > MAX_DIFF_BYTES) {
    const totalKB = Math.round(totalBytes / 1024);
    const truncated = Buffer.from(output, 'utf-8').slice(0, MAX_DIFF_BYTES).toString('utf-8');
    return truncated + `\n[diff truncated — showing first 50KB of ${totalKB}KB total]`;
  }

  return output;
}

export function buildReviewPrompt(diff: string, context?: string): string {
  const body = `Review these code changes carefully. For each issue found, use this EXACT format:
SEVERITY: file:line — description

Where SEVERITY is one of:
- CRITICAL: security vulnerabilities, data loss, crashes
- HIGH: logic errors, bugs, missing error handling
- LOW: style issues, naming, minor improvements

If everything looks correct, reply with: APPROVED

Changes:
${diff}`;

  return context ? `Context: ${context}\n\n${body}` : body;
}

const ISSUE_REGEX = /^(CRITICAL|HIGH|LOW):\s*(.+?)(?::(\d+)|\s*\((\d+)\))?\s*[—–-]\s*(.+)$/;

export function parseReviewResponse(agentId: string, response: string): CodeIssue[] {
  const issues: CodeIssue[] = [];

  for (const line of response.split('\n')) {
    const match = ISSUE_REGEX.exec(line.trim());
    if (!match) continue;

    const severity = match[1] as IssueSeverity;
    const file = match[2].trim();
    const lineNum = match[3] ?? match[4];
    const description = match[5].trim();

    issues.push({
      severity,
      file,
      line: lineNum !== undefined ? parseInt(lineNum, 10) : null,
      description,
      agentId,
    });
  }

  if (issues.length === 0) {
    if (/approved/i.test(response)) {
      return [];
    }
    return [
      {
        severity: 'HIGH',
        file: 'unknown',
        line: null,
        description: response.trim().slice(0, 200),
        agentId,
      },
    ];
  }

  return issues;
}

export function isBlocking(issues: CodeIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'CRITICAL' || issue.severity === 'HIGH');
}

export function deduplicateIssues(issues: CodeIssue[]): CodeIssue[] {
  const seen = new Set<string>();
  const result: CodeIssue[] = [];

  for (const issue of issues) {
    const key = `${issue.file}:${issue.line}:${issue.description.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(issue);
    }
  }

  return result;
}

export interface ReviewLoopConfig {
  maxAutoFixRounds: number;
  reviewers: FixyAdapter[];
  worker: FixyAdapter;
  projectRoot: string;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void;
  signal: AbortSignal;
}

export interface ReviewLoopResult {
  approved: boolean;
  rounds: number;
  allIssues: CodeIssue[];
  warnings: string[];
  escalated: boolean;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const PH = '\x1b[2;36m';
const RED = '\x1b[31m';
const DIM_YELLOW = '\x1b[2;33m';
const AGENT_COLORS: Record<string, string> = {
  claude: '\x1b[38;5;208m',
  codex: '\x1b[38;5;75m',
  gemini: '\x1b[38;5;141m',
};
const FIXY_COLOR = '\x1b[38;5;105m';

export async function runReviewLoop(
  config: ReviewLoopConfig,
  callAdapter: (adapter: FixyAdapter, prompt: string) => Promise<string>,
): Promise<ReviewLoopResult> {
  void DIM;
  void FIXY_COLOR;

  let diff = await collectGitDiff(config.projectRoot);

  if (!diff.trim()) {
    return { approved: true, rounds: 0, allIssues: [], warnings: [], escalated: false };
  }

  const allIssues: CodeIssue[] = [];
  let lowIssues: CodeIssue[] = [];

  for (let round = 1; round <= config.maxAutoFixRounds; round++) {
    if (config.signal.aborted) {
      return { approved: false, rounds: round - 1, allIssues, warnings: lowIssues.map((i) => `${i.file}:${i.line ?? '?'} — ${i.description}`), escalated: false };
    }

    const reviewPrompt = buildReviewPrompt(diff);

    config.onLog('stdout', `\n${PH}Fixy · Code review · round ${round}/${config.maxAutoFixRounds}${RESET}\n`);

    const roundIssues: CodeIssue[] = [];

    if (config.reviewers.length > 0) {
      const responses = await Promise.all(
        config.reviewers.map((reviewer) => callAdapter(reviewer, reviewPrompt)),
      );

      for (let i = 0; i < config.reviewers.length; i++) {
        const reviewer = config.reviewers[i];
        const response = responses[i];
        const agentColor = AGENT_COLORS[reviewer.id] ?? '\x1b[37m';

        config.onLog('stdout', `${agentColor}@${reviewer.id}:${RESET}\n`);

        const parsed = parseReviewResponse(reviewer.id, response);
        roundIssues.push(...parsed);
      }
    }

    const deduped = deduplicateIssues(roundIssues);
    allIssues.push(...deduped);

    const blockingIssues = deduped.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
    lowIssues = deduped.filter((i) => i.severity === 'LOW');

    for (const issue of blockingIssues) {
      config.onLog('stdout', `${RED}[${issue.severity}] ${issue.file}:${issue.line ?? '?'} — ${issue.description}${RESET}\n`);
    }

    for (const issue of lowIssues) {
      config.onLog('stdout', `${DIM_YELLOW}[LOW] ${issue.file}:${issue.line ?? '?'} — ${issue.description}${RESET}\n`);
    }

    if (blockingIssues.length === 0) {
      return {
        approved: true,
        rounds: round,
        allIssues,
        warnings: lowIssues.map((i) => `${i.file}:${i.line ?? '?'} — ${i.description}`),
        escalated: false,
      };
    }

    if (round < config.maxAutoFixRounds) {
      const issueList = blockingIssues
        .map((i) => `- [${i.severity}] ${i.file}:${i.line ?? '?'} — ${i.description}`)
        .join('\n');

      const fixPrompt = `Fix the following CRITICAL and HIGH severity issues in the code:\n\n${issueList}\n\nApply the necessary changes to resolve all listed issues.`;

      await callAdapter(config.worker, fixPrompt);

      diff = await collectGitDiff(config.projectRoot);
    }
  }

  return {
    approved: false,
    rounds: config.maxAutoFixRounds,
    allIssues,
    warnings: lowIssues.map((i) => `${i.file}:${i.line ?? '?'} — ${i.description}`),
    escalated: true,
  };
}
