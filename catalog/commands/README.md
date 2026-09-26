# Reusable command index

Select only commands useful to the target task. Adapt them into `.ai/commands/`; selected target commands may later have thin target-local slash adapters. Catalogue Markdown is not itself a slash command. Read this index before opening the task-relevant entry.

| When | Template | Inputs |
| --- | --- | --- |
| Assess affected consumers before planning or verification | [assess-change-impact.md](assess-change-impact.md) | Requested change or optional diff/ref, target policy index. |

| Audit documentation links, ownership, and contradictions | [audit-documentation.md](audit-documentation.md) | Selected documentation scope; optional accepted decision or change. Read-only findings. |

## Admission gate

A command ships only with required inputs, target/capability discovery, and a single done-when — without universal estimates, deployment steps, or provider procedures. Decided exclusions (generate target-local on explicit request instead): translation entry creation (excluded by catalogue scope decision), translation-update inventory (merge its change-inventory behavior into the task instead of a standalone entry), story-point estimation (team calibration is target-specific), version bumping (bind to the target release workflow when requested), worktree/conflict helpers beyond a thin entry to the existing Git skill, worktree operations, project database operations, and provider sprint procedures.
