---
fleet-template: repository-boundaries
fleet-source-version: 1
---
# Rule: Repository boundaries

Load when planning, changing or reviewing code that may cross module or contract boundaries. Adapt this rule to the target's documented owners and real dependency graph; do not import a reference repository's architecture.

## Rules
- Identify the affected module's responsibility and actual consumers before moving behavior or changing a shared contract. Cite explicit target policy where it exists; otherwise describe observed code as evidence, not as an enforceable layering rule.
- When an accepted boundary exists, keep ownership and public contract changes aligned with its consumers. Record deliberate exceptions with scope and rationale rather than hiding them in a generic rule.
- Trace cross-boundary impact for the requested change; distinguish direct callers from potential consumers that still need investigation.

## Scope and exceptions
The target adaptation must name applicable paths, interfaces and documented exceptions. Do not prescribe a service/repository split, SPA package, controller layout, or dependency direction without target evidence and an accepted decision.

## Verification
Check the target's policy and representative imports/callers, then inspect the changed contract and relevant tests or verification steps actually available. Flag unmapped consumers instead of asserting coverage.

## References
Use the target rule index and applicable project documentation; for change impact use the adapted command derived from `catalog/commands/assess-change-impact.md`. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
