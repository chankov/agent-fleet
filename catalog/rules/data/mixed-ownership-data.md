---
fleet-template: mixed-ownership-data
fleet-source-version: 1
---
# Rule: Generated facts and human decisions

Load when refreshing documents or structured data containing both generated observations and human-maintained annotations.

Disposition: retain ownership separation and evidence-based refresh; exclude provider schema and inventory layout.

## Rules
- Establish which fields are generated, human-maintained, or derived before updating. Follow existing target ownership markers and schema; do not introduce a universal format.
- Match records by the target's stable identity, not display names alone. Preserve human descriptions, decisions, and exceptions during refresh.
- Keep observed facts distinct from declared intent. Record evidence and freshness using target conventions; represent unknown values explicitly rather than guessing or treating them as empty facts.
- Failed or partial collection does not prove deletion. Flag missing records for reconciliation instead of silently removing them.
- Preview changes and resolve ambiguous identity or ownership conflicts before apply. Do not overwrite concurrent local edits.

## Scope and exceptions
Applies to mixed-ownership inventories, generated documentation, and service catalogues; wholly generated files follow their existing generation contract. Target schema defines unknown-value representation.

## Verification
Exercise a refresh with human annotations, unknown values, and incomplete collection. Confirm annotations survive, missing evidence does not delete records, and an unchanged refresh yields no unnecessary changes. Report checks that remain manual or unavailable.
