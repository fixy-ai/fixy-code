# Contributing to Fixy Code

## Prerequisites

- Node.js 20+
- pnpm 9+

## Setup

```sh
git clone https://github.com/fixy-ai/fixy-code.git
cd fixy-code
pnpm install
```

## Development Commands

| Command | Description |
|---------|-------------|
| `pnpm -r build` | Build all packages |
| `pnpm -r typecheck` | Run TypeScript type checking |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Run ESLint with auto-fix |
| `pnpm format` | Check formatting with Prettier |
| `pnpm format:fix` | Fix formatting with Prettier |
| `pnpm test` | Run tests with Vitest |

## Project Structure

See [README.md](README.md) for an overview of the monorepo layout.

## Pull Requests

Please fill out the PR template when submitting changes. Every PR should reference which step from `IMPLEMENTATION-PLAN-FIXYCODE.md` it relates to.
