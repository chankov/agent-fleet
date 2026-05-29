---
description: Implement the next task incrementally - build, test, verify, commit
---

Invoke the `incremental-implementation` skill and the `test-driven-development` skill via the `skill` tool.

Pick the next pending task from the plan. For each task:

1. Read the task's acceptance criteria.
2. Load relevant context: existing code, patterns, and types.
3. Write a failing test for the expected behavior.
4. Implement the minimum code to pass the test.
5. Run the relevant test suite to check for regressions.
6. Run the build to verify compilation.
7. Mark the task complete and move to the next one.

If any step fails, invoke the `debugging-and-error-recovery` skill via the `skill` tool.
