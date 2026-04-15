import { describe, it, expect } from 'vitest';
import { detectIntent } from '../intent.js';

describe('detectIntent', () => {
  describe('question detection', () => {
    it.each([
      ['what framework should I use?', 'question'],
      ['how does the auth middleware work?', 'question'],
      ['which is better, React or Vue?', 'question'],
      ['should we use TypeScript?', 'question'],
      ['can you explain this function?', 'question'],
      ['is this approach correct?', 'question'],
      ['why is the test failing?', 'question'],
      ['what are the pros and cons of microservices?', 'question'],
    ] as const)('%s → %s', (input, expected) => {
      expect(detectIntent(input)).toBe(expected);
    });
  });

  describe('task detection', () => {
    it.each([
      ['build a REST API with authentication', 'task'],
      ['add error handling to the router', 'task'],
      ['fix the null pointer in auth.ts', 'task'],
      ['refactor the database module', 'task'],
      ['create a new component for user settings', 'task'],
      ['implement OAuth2 refresh tokens', 'task'],
      ['remove the deprecated API endpoints', 'task'],
      ['update @./src/config.ts with new env vars', 'task'],
    ] as const)('%s → %s', (input, expected) => {
      expect(detectIntent(input)).toBe(expected);
    });
  });

  describe('ambiguous detection', () => {
    it.each([
      // Note: "improve" and "clean" are not in TASK_STARTERS, no question signals → ambiguous
      ['improve the error handling', 'ambiguous'],
      ['clean up the code', 'ambiguous'],
      // Note: "make" and "optimize" ARE in TASK_STARTERS → task (priority rule 2)
      ['make it faster', 'task'],
      ['optimize performance', 'task'],
    ] as const)('%s → %s', (input, expected) => {
      expect(detectIntent(input)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('empty string → ambiguous', () => {
      expect(detectIntent('')).toBe('ambiguous');
    });

    it('"?" → question', () => {
      expect(detectIntent('?')).toBe('question');
    });

    it('"build" (single action verb) → task', () => {
      expect(detectIntent('build')).toBe('task');
    });

    it('"can you build a REST API?" → question (ends with ?)', () => {
      expect(detectIntent('can you build a REST API?')).toBe('question');
    });
  });
});
