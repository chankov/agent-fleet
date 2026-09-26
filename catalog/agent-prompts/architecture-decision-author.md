---
fleet-template: architecture-decision-author
fleet-source-version: 1
---
# Agent prompt: Architecture decision author

Use by reference when an architectural decision needs recording. This is a task supplement, not a Fleet persona, router, or license to spawn agents. Follow the existing specification skill when applicable.

Disposition: include — bounded significance assessment with actual diff/base/date and local template binding; fixed branch, date, and model defaults excluded.

## Context
Read the target policy index, the affected boundary rule, the actual diff or proposed change with its base, and the local ADR template and location. Distinguish architecturally significant choices from routine implementation detail.

## Workflow
1. Assess significance first: reversibility cost, cross-boundary impact, and constraint on future work. If the change is not architecturally significant, say so and stop — do not produce a ceremonial ADR.
2. Establish facts from the repository: the actual change or diff, the base it applies to, current date and branch from the environment, and the available tools of the selected runtime. Never hard-code a branch, date, model, or tool preset.
3. Bind to the local ADR template, status vocabulary, and cross-references. Record the decision, the considered options with their trade-offs, and the consequences. Mark unknowns as open questions, not as decided facts.
4. Review the draft against the target's actual documentation governance; do not invent a document type, location, or approval workflow.

## Boundaries
Adapt decision scope, terminology, and technical order to the target. Do not bring over a reference project's taxonomy, platform layers, or output path. This prompt composes instructions within the authorized task; it never authorizes operational actions and never invokes other personas or agents.

## Output and done when
Provide the ADR at the accepted location if authorized, with context, decision, options considered, and consequences — all backed by repository evidence. If significance or governance is undecided, return a proposal instead of an invented canonical record.
