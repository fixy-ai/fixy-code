// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginN from 'eslint-plugin-n';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },

  // Base JS recommended for all files
  js.configs.recommended,

  // TypeScript strict config for .ts files
  ...tseslint.configs.strict,

  // Node.js plugin
  {
    plugins: {
      n: pluginN,
    },
    rules: {
      'n/no-process-exit': 'warn',
      'n/prefer-node-protocol': 'error',
    },
  },

  // Import-x plugin
  {
    plugins: {
      'import-x': importX,
    },
    rules: {
      'import-x/no-duplicates': 'error',
    },
  },

  // Main config targeting all TS source files in packages
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused vars: warn, allow underscore-prefixed args
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Enforce consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Allow empty files / barrel exports
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
