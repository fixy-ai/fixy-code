import { execSync } from 'node:child_process';

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
