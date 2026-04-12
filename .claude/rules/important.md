## **ABSOLUTE PROHIBITION — DATA DESTRUCTION**

**NEVER, UNDER ANY CIRCUMSTANCES, DELETE:**
- **Project files** — Do NOT delete implementation files, configuration files, or any file that contains working code or data.
- **Local files on the user's PC** — Do NOT delete, move, or destroy ANY files on the user's machine outside the immediate scope of the task.

**This rule has NO exceptions. No "cleanup", no "fresh start", no "reset". If in doubt, ASK. Violations of this rule are UNACCEPTABLE and IRREVERSIBLE.**

---

## General Rules

* **READ ALL RULES BEFORE DOING ANYTHING**
* **READ MY MESSAGES BEFORE DOING ANYTHING** and **DO NOT BYPASS OR IGNORE OR SHORTEN MY MESSAGES** to understand them better.
* **NO mocks, NO demos, ONLY production.**
* **Do NOT change or modify any unrelated code, and do NOT break the project's functionality.**
* **Always communicate in English.**
* **NEVER break existing working features.** After every change, verify that previously working flows still function correctly. New changes that regress working logic are unacceptable.
* **After successfully implementing a feature, remove any redundant code or files you created that are no longer needed.**
* **Use modern TypeScript patterns** — ES2022+ syntax, strict mode. Avoid deprecated patterns (var declarations, legacy APIs).
* **NEVER kill processes on ANY port without EXPLICITLY asking the user first.** Other ports may be running completely unrelated applications. Killing processes on other ports has destroyed the user's other running applications before — this is UNACCEPTABLE.

## Before Starting Any Task
1. Run `git add -A && git commit -m "checkpoint before: [brief task description]"` before making any changes.
2. List every file you plan to modify and explain why.
3. Wait for my approval before making changes.
4. After completing changes, list every file you actually modified.

## AI Agent Session Rules
* **Always read `IMPLEMENTATION-PLAN-FIXYCODE.md`** before starting any work. Understand what has been done and what is pending.
* **MANDATORY: ALWAYS commit after finishing work.** Run `git add` for all modified files and `git commit` with a descriptive message at the end of every task. Never leave uncommitted changes.
* **MANDATORY: End-of-session checklist — in this exact order:**
  1. Run `pnpm -r typecheck` to verify the project typechecks without errors
  2. Run `pnpm -r build` to verify the project builds without errors
  3. Run `pnpm test` to verify all tests pass
  4. Run `git add` for all modified files and `git commit` with a descriptive message
  Never skip any of these steps. Never commit without a successful build.
* **Always leave the project in a buildable state.** After completing any task, `pnpm install`, `pnpm -r build`, and `pnpm -r typecheck` must all succeed. No broken imports, no missing dependencies.

## Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| Runtime | Node.js 20+ | TypeScript, strict mode |
| Build | pnpm workspaces | Monorepo with packages/* |
| Test | Vitest | Unit + integration |
| Lint | ESLint + Prettier | Flat config |
| npm scope | `@fixy` | All packages under @fixy/* |
| License | MIT | |

### DO NOT ADD:
- No unnecessary dependencies
- No ORMs
- No frameworks (Express, React, etc.) — this is a CLI tool
- Always use the latest stable versions of packages

## Project Structure

```
fixy-code/
├── IMPLEMENTATION-PLAN-FIXYCODE.md  # Master implementation plan & progress tracker
├── CLAUDE.md                        # Agent coding directives
├── package.json                     # Root — pnpm workspace
├── pnpm-workspace.yaml              # packages: ["packages/*"]
├── tsconfig.base.json               # Shared TypeScript config
└── packages/
    ├── core/                        # Thread, router, worktree, collaboration engine
    ├── adapter-utils/               # Subprocess spawning, env building, log helpers
    ├── cli/                         # Terminal REPL entry point (@fixy/cli)
    ├── claude-adapter/              # Claude Code CLI adapter
    └── codex-adapter/               # Codex CLI adapter
```

## Regression Prevention

### The Rules
1. **Before changing any file**, understand what existing functionality depends on it.
2. **After every change**, verify that related features still work.
3. **Never assume** a change is isolated — trace dependencies before committing.

## Minimal Change Principle

* **Change ONLY the exact line/property that is broken.** Do NOT restructure, reorganize, or "clean up" surrounding code.
* If a fix requires changing more than 5 lines, STOP and explain why to the user before proceeding.
* Never move, reorder, or rename code that already works — even if it "looks better."
* One fix = one surgical edit. If you think something else also needs fixing, REPORT it to the user — do NOT fix it silently.

## No Cascading Fixes

* If fixing issue A reveals issue B, **STOP**. Report issue B to the user and wait for instructions.
* Do NOT chain fixes: fix A -> notice B -> fix B -> notice C -> fix C. This is how regressions happen.
* Each fix must be isolated and independently verified before moving on.

## Pre-Edit Impact Check (MANDATORY before every edit)

Before writing any Edit/Write tool call, answer these 3 questions:
1. **What does this line/block currently do?** (read it, don't assume)
2. **What else depends on this line/block?** (grep for usages)
3. **Will my change affect anything beyond the specific task I'm doing?** (if yes, STOP and ask)

## Verify, Don't Assume

* After making a change, READ the modified file back to verify the edit is correct.
* Never assume a type/interface exists — check the definition first.
* If you're unsure whether a change will break something, ASK instead of guessing.

## Codebase-Wide Verification (MANDATORY)

**Every change must be verified across the ENTIRE codebase, not just the 1-2 files you edited.** Before marking any task as complete:

1. **Search the whole codebase** for every module, type, and function that uses what you changed. Use `Grep` to find ALL usages.
2. **Verify every occurrence works correctly.**
3. **List every affected location** in your response so the user can verify you checked them all.
