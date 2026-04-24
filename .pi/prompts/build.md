---
description: Implement the next task incrementally — build, test, verify, request review
---

Load and follow the `incremental-implementation` and `test-driven-development` skills before proceeding.

Pick the next pending task from the plan. For each task:

1. Read the task's acceptance criteria
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Present the Standard Slice Summary and wait for explicit user approval before continuing
8. Leave changes unstaged; the user handles staging and commits manually
9. Mark the task complete and move to the next one only after approval

If any step fails, load and follow the `debugging-and-error-recovery` skill.
