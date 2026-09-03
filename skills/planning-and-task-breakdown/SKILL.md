---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks and grills unspecified design forks before writing them. Use when you have a spec or clear requirements and need to break work into implementable tasks. Use when a task feels too large to start, when you need to estimate scope, when parallel work is possible, or when more than one valid approach exists and the plan must lock a choice.
---

# Planning and Task Breakdown

## Overview

Decompose work into small, verifiable tasks with explicit acceptance criteria. Good task breakdown is the difference between an agent that completes work reliably and one that produces a tangled mess. Every task should be small enough to implement, test, and verify in a single focused session.

## When to Use

- You have a spec and need to break it into implementable units
- A task feels too large or vague to start
- Work needs to be parallelized across multiple agents or sessions
- You need to communicate scope to a human
- The implementation order isn't obvious
- More than one valid approach, a contradiction, or competing code patterns must be locked before tasks are written

**When NOT to use:** Single-file changes with obvious scope, or when the spec already contains well-defined tasks. Skipping a plan file does **not** skip grilling: if the change can be done several ways and none is mandated, ask before coding.

## Proportionality gate (check before writing anything)

A plan is overhead the human pays for. Before you write one, size it against the ask:

| The ask | The right artifact |
|---|---|
| One obvious change, one file, low risk | **No plan.** Make the change and say what you did. |
| A contained change in familiar code | A task list in your reply — 3–6 lines, no plan file. |
| Multi-step work, unfamiliar code, or real risk | A plan file, as below. |

Rules that follow from this:

- **Never write a plan longer than the work it plans.** If the plan document would take longer to read than the change takes to make, it is the wrong artifact.
- **A safety requirement is a task, not a subsystem.** "Don't remove existing permissions" is one acceptance criterion with one verification step — not a hash-pinned manifest, an immutable evidence namespace, and a fixture suite. Provenance machinery is warranted only when the human asked for an audit trail or the change is irreversible at scale.
- **Plan the ask, not the neighbourhood.** Adjacent problems you notice go in a short "Out of scope / noticed" list at the end for the human to decide on. They do not become tasks.
- **Split by phase when the phases have different owners.** Repository work, cloud/infrastructure preparation, deployment, and retirement belong in separate plans: bundling them means the whole plan is blocked on whichever phase stalls, and every review re-reads all of it.
- **Review findings do not silently enlarge the plan.** When a plan revision adds requirements nobody asked for, say so explicitly and let the human accept or drop them.
- **Unspecified forks still get grilled.** Skipping a plan file does not skip a load-bearing choice. Already-stated requirements (chat, prompt, PRD, rules) are not re-asked.

## Output Location

By default, save the plan to `docs/plans/{area}/PLAN-{prd-name}-{phase}.md`:

- `{area}` — the functional area; match the area of the PRD this plan implements.
- `{prd-name}` — the name of the PRD this plan implements (e.g. `PRD3-tournament-copy`). If there is no PRD, use a short kebab-case topic slug instead.
- `{phase}` — include a phase suffix **only** when the plan is deliberately split across more than one plan file. For a single-file plan, drop it (`PLAN-{prd-name}.md`).

The task list is **embedded** in the plan file as the `## Task List` section. Do **not** create a separate `todo.md`.

Match the project's existing `docs` vs `Docs` capitalization, and create the directory if it does not exist.

**Project overrides:** if `.ai/agent-fleet-overrides.md` has a `## planning-and-task-breakdown` section, its keys (`plan-dir`, `naming`, `todo`) override these defaults — `todo: separate` restores a standalone `todo.md`. See [docs/agent-fleet-setup.md](../../docs/agent-fleet-setup.md).

## The Planning Process

### Step 1: Enter Plan Mode

Before writing any code, operate in read-only mode:

- Read the spec and relevant codebase sections
- Identify existing patterns and conventions
- Map dependencies between components
- Note risks and unknowns

**Do NOT write code during planning.** The output is a plan document, not implementation.

**Grilling (required before writing tasks):** Read the shared internal helper at [`../_internal/grilling.md`](../_internal/grilling.md). Inventory load-bearing decisions. Skip anything already explicit in chat, prompt, PRD, spec, or rules. Grill every remaining fork (multiple valid ways, contradiction, competing code patterns) one question at a time, with a recommended option. Do not write tasks while a load-bearing choice is still silently assumed. Update Architecture Decisions, Risks, and Open Questions with accepted, rejected, or deferred choices. If nothing is open, note that grilling found no unspecified forks and continue.

**Model poll (planner, when `delegate` is available):** On an unresolved architectural fork at task tier `feature` or `project`, run `voice-1`, `voice-2`, and `voice-3` **after** recon (`scout`/`rules`), never in the same message, with a character-for-character identical instruction. Do not poll on `trivial`/`small` (delegation is off) and do not invent a poll if `delegate` is missing. Agreement becomes an accepted architectural decision in the plan, naming the voices; write a `POLL-{prd-name}.md` digest next to the plan and cite it. Divergence becomes one `ASK_USER:` question with one option per position plus a recommendation and reason — do not write the plan in that same turn.

### Step 2: Identify the Dependency Graph

Map what depends on what:

```
Database schema
    │
    ├── API models/types
    │       │
    │       ├── API endpoints
    │       │       │
    │       │       └── Frontend API client
    │       │               │
    │       │               └── UI components
    │       │
    │       └── Validation logic
    │
    └── Seed data / migrations
```

Implementation order follows the dependency graph bottom-up: build foundations first.

### Step 3: Slice Vertically

Instead of building all the database, then all the API, then all the UI — build one complete feature path at a time:

**Bad (horizontal slicing):**
```
Task 1: Build entire database schema
Task 2: Build all API endpoints
Task 3: Build all UI components
Task 4: Connect everything
```

**Good (vertical slicing):**
```
Task 1: User can create an account (schema + API + UI for registration)
Task 2: User can log in (auth schema + API + UI for login)
Task 3: User can create a task (task schema + API + UI for creation)
Task 4: User can view task list (query + API + UI for list view)
```

Each vertical slice delivers working, testable functionality.

### Step 4: Write Tasks

Each task follows this structure:

```markdown
## Task [N]: [Short descriptive title]

**Description:** One paragraph explaining what this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: `npm test -- --grep "feature-name"`
- [ ] Build succeeds: `npm run build`
- [ ] Manual check: [description of what to verify]

**Dependencies:** [Task numbers this depends on, or "None"]

**Files likely touched:**
- `src/path/to/file.ts`
- `tests/path/to/test.ts`
```

### Step 5: Order and Checkpoint

Arrange tasks so that:

1. Dependencies are satisfied (build foundation first)
2. Each task leaves the system in a working state
3. Verification checkpoints occur after every 2-3 tasks
4. High-risk tasks are early (fail fast)

Add explicit checkpoints:

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core user flow works end-to-end
- [ ] Review with human before proceeding
```

## Task Sizing Guidelines

If a task is 5-8 files (Multi-component feature , such as Search with filtering and pagination) or larger, it should be broken into smaller tasks. An agent performs best on 1-5 file tasks.

**When to break a task down further:**
- It would take more than one focused session (roughly 2+ hours of agent work)
- You cannot describe the acceptance criteria in 3 or fewer bullet points
- It touches two or more independent subsystems (e.g., auth and billing)
- You find yourself writing "and" in the task title (a sign it is two tasks)

## Plan Document Template

```markdown
# Implementation Plan: [Feature/Project Name]

## Overview
[One paragraph summary of what we're building]

## Architecture Decisions
- [Key decision 1 and rationale]
- [Key decision 2 and rationale]

## Task List

### Phase 1: Foundation
- [ ] Task 1: ...
- [ ] Task 2: ...

### Checkpoint: Foundation
- [ ] Tests pass, builds clean

### Phase 2: Core Features
- [ ] Task 3: ...
- [ ] Task 4: ...

### Checkpoint: Core Features
- [ ] End-to-end flow works

### Phase 3: Polish
- [ ] Task 5: ...
- [ ] Task 6: ...

### Checkpoint: Complete
- [ ] All acceptance criteria met
- [ ] Ready for review

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk] | [High/Med/Low] | [Strategy] |

## Open Questions
- [Question needing human input]
```

## Parallelization Opportunities

When multiple agents or sessions are available:

- **Safe to parallelize:** Independent feature slices, tests for already-implemented features, documentation
- **Must be sequential:** Database migrations, shared state changes, dependency chains
- **Needs coordination:** Features that share an API contract (define the contract first, then parallelize)

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure it out as I go" | That's how you end up with a tangled mess and rework. 10 minutes of planning saves hours. |
| "The tasks are obvious" | Write them down anyway. Explicit tasks surface hidden dependencies and forgotten edge cases. |
| "Planning is overhead" | Planning is the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Context windows are finite. Written plans survive session boundaries and compaction. |
| "The PRD already covers everything, no need to grill" | Then grilling produces zero questions. Still run the inventory so silent forks do not slip through. |
| "I'll pick the obvious variant and note it in Architecture Decisions" | If more than one variant exists and none was mandated, it is not obvious to the programmer who was not in the room. Ask, then record the choice. |
| "Re-confirming the PRD points shows thoroughness" | Re-asking settled requirements wastes the user and implies the agent did not read them. Skip them. |

## Red Flags

- Starting implementation without a written task list
- Tasks that say "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks touches more than 8+ files
- No checkpoints between tasks
- Dependency order isn't considered
- Writing tasks that silently pick a library, pattern, or behavior not mandated in chat/PRD/rules
- Re-asking a requirement already explicit in chat, prompt, PRD, spec, or rules
- Leaving an unspecified fork as an Open Question without asking

## Verification

Before starting implementation, confirm:

- [ ] Every task has acceptance criteria
- [ ] Every task has a verification step
- [ ] Task dependencies are identified and ordered correctly
- [ ] No task touches more than ~5 files
- [ ] Checkpoints exist between major phases
- [ ] The human has reviewed and approved the plan
- [ ] Grilling ran before tasks were written (inventory of load-bearing decisions)
- [ ] Already-stated requirements (chat, prompt, PRD, spec, rules) were not re-asked
- [ ] Each remaining load-bearing decision has an accepted/rejected/deferred status in the plan
- [ ] No open questions left (All are resolved/answered/commented)

## See Also

Acceptance criteria are per-task and answer "did we build the right thing?". They sit on top of the project-wide Definition of Done, the standing bar every task clears before it counts as done. See `references/definition-of-done.md`.
