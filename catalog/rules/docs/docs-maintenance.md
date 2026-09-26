---
fleet-template: docs-maintenance
fleet-source-version: 1
---
# Rule: Documentation maintenance

Load when creating, changing, or reviewing project documentation. Adapt this policy to the target's accepted document types, paths, and indexes; it is a starting point, not target policy.

Disposition: partial extraction — canonical sources and update-together kept; prescribed types, paths, and numbering excluded. Allowed document types require an explicit local decision; this template carries no default taxonomy.

## Rules
- Treat the target's documentation index and canonical sources as the entry points; new documents link from the index instead of living orphaned.
- Update accepted contracts together: a behavior change updates the rule, the affected documents, and the index in the same change — never code without its documented contract, never a document contradicting the code it describes.
- When an accepted decision changes, synchronize affected implementation, tests, plans, and specifications in the same change. Remove stale contradictory current requirements before review; preserve historical decisions as clearly superseded records rather than rewriting history. Name any affected artifact that cannot be updated and report the gap instead of claiming synchronization.
- The allowed document types, their paths, and their templates are an explicit target decision (for example a subset of PRD / ADR / runbook / playbook / support notes, or none). Do not import a reference project's taxonomy, numbering, branch defaults, or output paths.
- Keep examples short and separated from normative instructions; legacy, generated, and historical examples are references, not standards.

## Scope and exceptions
Applies to documentation sources in the target. The target adaptation must name the accepted types, their locations, the index file, and any explicit exceptions (for example decisions recorded only in chat for a defined period).

## Verification
Check that the changed document is reachable from the index, that the referenced behavior matches the code, and that no orphaned or duplicated policy remains. Flag unmapped documents instead of asserting coverage.

## References
Use the target rule index and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
