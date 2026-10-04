---
description: Implement the next task incrementally — build, test, verify, request review unless whole-plan was explicitly requested
---

Load and follow the `incremental-implementation` and `test-driven-development` skills before proceeding. The skill owns the execution mode. Do not invent a second policy here.

Default: pick the next pending task from the plan. Whole-plan: only when the operator explicitly requested it in this execution instruction, or an operator-authored plan line already says so. A small plan or a worktree is not that request. Then run every pending task in order under the skill's whole-plan section.

For each task:

1. Read the task's acceptance criteria
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Default path only: present the Standard Slice Summary and ask the user to choose between:
   - **Approve & continue** — proceed to the next slice
   - **Request changes** — revise within the same slice, then re-summarize and re-ask
   - **Compact & continue** — call `request_compaction` (from the `compact-and-continue` extension) with a self-contained `continuationPrompt` describing the remaining slices and the next concrete action, then end the turn so compaction runs; pi will auto-resume from the continuation prompt
   - **Stop here** — leave changes unstaged and end the session
   Use the `ask_user` tool (from `pi-ask-user`) when available; otherwise ask in chat. Wait for an explicit choice — do not proceed on silence. If the `request_compaction` tool is not registered (extension not installed), omit the "Compact & continue" option.
   Whole-plan path: do not ask for slice approval between tasks. If an unresolved problem appears in the plan or the PRD, interrupt immediately, grill it, and call `ask_user` (one question, 2–4 options, a recommendation). Wait. Do not continue later tasks in that turn. If you compact, the continuation prompt must restate the whole-plan opt-in, the remaining tasks, and that an unresolved problem still interrupts for grilling and `ask_user`.
8. Leave changes unstaged; the user handles staging and commits manually
9. Default path: mark the task complete and move to the next one only after approval. Whole-plan path: mark it complete after local verification and continue until the plan is done, a check fails, or an unresolved problem interrupts for `ask_user`. End with one plan summary, not an approval question.

If any step fails, load and follow the `debugging-and-error-recovery` skill. Do not skip ahead.
