---
fleet-template: verification-conventions
fleet-source-version: 1
---
# Rule: Verification conventions

Load when a rule, command, or prompt needs an observable check. This template binds policy to the target's actual checkers; it does not duplicate the Fleet testing skills or invent thresholds.

Disposition: partial extraction — rule-to-check binding kept; workflow duplication excluded. Testing workflow itself stays with the existing Fleet skills; this file only constrains how rules claim verification.

## Rules
- Every rule's Verification section names an observable check or an existing checker (test command, linter, type checker, review step). A rule with no available check says so and assigns review responsibility with evidence — it never invents a threshold, coverage number, or gate.
- Existing quality gates (`quality:` under `## workflows`, CONSTRAINTS.md where present) stay canonical. Setup reads and links them; it introduces no second quality subsystem and no blocking-versus-advisory change without an explicit decision.
- Blocking checks must already run in the target (CI or task-end command). Advisory observations stay advisory until the target promotes them.
- Verification of an adaptation inspects meaning as well as placeholders: no imported defaults without target evidence, no invented paths or commands, no dropped applicable constraint.

## Scope and exceptions
Applies to all target `.ai/` content. Exceptions (checks that are advisory, manual, or owned by review) are named per rule, with owner and reason.

## Verification
This rule is self-descriptive: confirm each adapted rule links to a real checker or explicitly assigns review. Flag rules whose checks do not exist in the target.

## References
Use the target rule index, CONSTRAINTS.md where present, and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
