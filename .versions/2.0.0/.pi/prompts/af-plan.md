---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
---

Load and follow the `planning-and-task-breakdown` skill before proceeding.

Read the existing spec (SPEC.md or equivalent) and the relevant codebase sections. Then:

1. Enter plan mode — read only, no code changes
2. Grill unspecified forks per the planning skill's grilling helper — skip anything already explicit in chat, prompt, PRD, spec, or rules; ask one question at a time (with a recommended option) for every remaining multiple-valid-way, contradiction, or competing code pattern; do not write tasks while a load-bearing choice is still assumed
3. Identify the dependency graph between components
4. Slice work vertically (one complete path per task, not horizontal layers)
5. Write tasks with acceptance criteria and verification steps
6. Add checkpoints between phases
7. Present the plan for human review

Save the plan to the location the `planning-and-task-breakdown` skill defines (default `docs/plans/{area}/PLAN-{prd-name}-{phase}.md`, with the task list embedded — no separate todo file; overridable per project via `.ai/agent-fleet-overrides.md`). Match the project's existing `docs`/`Docs` capitalization.
