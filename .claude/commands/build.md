---
description: Implement tasks incrementally — build, test, verify, commit. Add "auto" to run the whole plan in one approved pass.
---

Invoke the agent-skills:incremental-implementation skill alongside agent-skills:test-driven-development.

## Modes

- **`/build`** — implement the *next* pending task, then stop (careful, one slice at a time).
- **`/build auto`** — generate the plan if needed, get a single approval, then implement *every* task without stopping between them.

`$ARGUMENTS` selects the mode. Treat `auto`, `all`, or `fast` as autonomous mode; anything else (or empty) is the default single-task mode.

## Default: one task

Pick the next pending task from the plan. Then:

1. Read the task's acceptance criteria
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Commit with a descriptive message
8. Mark the task complete and stop

## Autonomous: the whole plan (`/build auto`)

Use this once a spec exists and you want to collapse plan + build into one run. It removes the manual stepping between tasks — **not** the verification. Every task still earns a passing test and its own commit.

1. **Require a spec.** If there is no `SPEC.md` (or equivalent), stop and tell the user to run `/spec` first. Do not invent requirements.
2. **Plan if needed.** If there is no `tasks/plan.md`, invoke agent-skills:planning-and-task-breakdown to generate one.
3. **Single checkpoint.** Present the full plan and get explicit approval. This is the only human gate — after approval, run autonomously.
4. **Execute every task in dependency order.** For each task, run the full default loop above (RED → GREEN → regression → build → commit per task → mark complete). One commit per task so any point is a clean rollback.
5. **Stop and ask the user** (do not push through) when:
   - a test can't be made to pass or the build breaks without an obvious fix → follow agent-skills:debugging-and-error-recovery
   - the spec is ambiguous, or a task needs a decision the spec doesn't cover
   - a task is high-risk or irreversible — auth/permission changes, destructive data migrations, payments, deletions, deploys, or anything touching secrets → follow agent-skills:doubt-driven-development and get explicit sign-off before continuing
6. **Summarize at the end:** tasks completed, tests added, commits made, and anything skipped, flagged, or left for the user.

If any step fails, follow the agent-skills:debugging-and-error-recovery skill.
