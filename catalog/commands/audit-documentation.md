---
fleet-template: audit-documentation
fleet-source-version: 1
---
# Command: Audit documentation consistency

Use when reviewing a selected documentation scope for consistency. Inputs: requested files or documentation area; optional accepted decision or change to check against. This command is read-only and authorizes no external actions.

Disposition: extract evidence-backed auditing; exclude mandatory document taxonomy, paths, and automatic consolidation.

## Process
1. Discover the target documentation index, canonical sources, applicable policy, and requested scope. Ask if scope cannot be resolved; do not silently audit the whole repository.
2. Check local links and anchors with existing tooling where available. Distinguish broken references from unavailable external targets; do not fetch external links without appropriate authorization.
3. Find orphaned pages relative to the target's indexing policy, duplicated guidance, and contradictory current instructions. Historical decisions, generated copies, and examples are not automatically conflicting current policy.
4. Compare claims with relevant implementation, tests, and accepted decisions where accessible. Cite both sides of each conflict and separate confirmed findings from suspected ones.
5. Suggest canonical owners and focused corrections using target evidence. Where ownership is unresolved, present a question rather than choosing silently. Do not edit, delete, or consolidate files.

## Output and done when
Report inspected scope, findings with file/section evidence, suggested canonical owners, and proposed corrections. List inaccessible sources and unchecked areas explicitly. Completion means the requested audit is reported, not that every document is correct or that fixes have been applied.
