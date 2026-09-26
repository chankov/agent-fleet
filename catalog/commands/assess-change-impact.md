---
fleet-template: assess-change-impact
fleet-source-version: 1
---
# Command: Assess change impact

Use when a change needs an evidence-backed list of affected areas and verification priorities. Inputs: requested change or pending diff; optional ref/range if supported by the target VCS. An invocation does not authorize writes or external actions.

## Process
1. Read the target `.ai/rules/README.md`, applicable boundary rule, and relevant existing documentation. For a future change with no diff, identify the proposed interfaces and likely owners; do not fabricate changed files.
2. Establish the affected files from the requested scope or actual diff. Trace inbound consumers via the target's real imports, callers, event subscriptions, interfaces or deployed entry points. Follow concrete links, not filenames alone.
3. Classify each impact as direct, indirect or unmapped; note evidence and limits. Map to user-facing or operational entry points **only where they exist**. Do not presume an SPA, router, HTTP controller, language prefix or a specific client.
4. Identify the target's actual checks and a short prioritized verification list. If asked to turn the analysis into a project requirements document, use the **adapted project-task prompt** in the target `.ai/agent-prompts/` index by reference, not by copying it into this command.

## Decision points
Ask with a recommendation when competing ownership or verification choices cannot be resolved from accepted target policy. An observed pattern alone does not authorize a new normative boundary.

## Output and done when
Report scope, file/consumer-to-entry-point traces with evidence, direct/indirect/unmapped confidence, and prioritized checks. Explicitly list unknown consumers. No route or endpoint is reported as confirmed without a real reference.
