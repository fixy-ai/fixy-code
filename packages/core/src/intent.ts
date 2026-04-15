export type InputIntent = 'question' | 'task' | 'ambiguous';

// Words that strongly signal a question when at the start of the input
const QUESTION_STARTERS =
  /^(what|which|how|why|should|could|would|is|are|do|does|can|will|where|when|who)\b/i;

// Phrases anywhere in the input that signal a question
const QUESTION_PHRASES =
  /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference between\b|\bpros and cons\b|\brecommend\b|\bsuggest\b|\bthink about\b|\bopinion on\b|\bthoughts on\b|\badvice on\b|\bbest way\b|\bbetter\b|\btell me\b|\bexplain\b|\bshow me\b|\blist\b|\bdescribe\b|\bwhat are\b|\bwhat is\b/i;

// Action verbs that strongly signal a task when at the start of the input
const TASK_STARTERS =
  /^(build|create|add|implement|fix|refactor|update|remove|delete|migrate|deploy|write|design|setup|configure|install|move|rename|optimize|test|make|change|replace|convert|extract|split|merge|integrate)\b/i;

// File references that signal a task (path references or common extensions in context)
const FILE_REFERENCE =
  /@\.\/|(?:^|\s)\S+\.(ts|js|tsx|jsx|py|go|rs|json|yaml|yml|md)(?:\s|$)/i;

export function detectIntent(input: string): InputIntent {
  const trimmed = input.trim();

  // Edge case: empty string
  if (trimmed.length === 0) return 'ambiguous';

  // Priority rule 1: ends with '?' → always question
  if (trimmed.endsWith('?')) return 'question';

  // Priority rule 2: starts with a strong action verb and has no '?' → always task
  if (TASK_STARTERS.test(trimmed)) return 'task';

  // Count signals
  let questionScore = 0;
  let taskScore = 0;

  if (QUESTION_STARTERS.test(trimmed)) questionScore += 2;
  if (QUESTION_PHRASES.test(trimmed)) questionScore += 1;

  if (FILE_REFERENCE.test(trimmed)) taskScore += 1;

  if (questionScore > taskScore) return 'question';
  if (taskScore > questionScore) return 'task';

  return 'ambiguous';
}
