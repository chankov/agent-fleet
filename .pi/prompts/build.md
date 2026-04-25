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
7. Present the Standard Slice Summary and ask the user to choose between:
   - **Approve & continue** — proceed to the next slice
   - **Request changes** — revise within the same slice, then re-summarize and re-ask
   - **Compact & continue** — call `request_compaction` (from the `compact-and-continue` extension) with a self-contained `continuationPrompt` describing the remaining slices and the next concrete action, then end the turn so compaction runs; pi will auto-resume from the continuation prompt
   - **Stop here** — leave changes unstaged and end the session
   Use the `ask_user` tool (from `pi-ask-user`) when available; otherwise ask in chat. Wait for an explicit choice — do not proceed on silence. If the `request_compaction` tool is not registered (extension not installed), omit the "Compact & continue" option.
8. Leave changes unstaged; the user handles staging and commits manually
9. Mark the task complete and move to the next one only after approval

If any step fails, load and follow the `debugging-and-error-recovery` skill.
