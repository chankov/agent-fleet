---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---

Invoke the `planning-and-task-breakdown` skill via the `skill` tool.

Read the existing spec, such as `SPEC.md`, and relevant codebase sections. Then:

1. Enter planning mode: read only, no code changes.
2. Identify the dependency graph between components.
3. Slice work vertically, with one complete path per task rather than horizontal layers.
4. Write tasks with acceptance criteria and verification steps.
5. Add checkpoints between phases.
6. Present the plan for human review.

Save the plan to `tasks/plan.md` and the task list to `tasks/todo.md` only after the user confirms the plan should be written.
