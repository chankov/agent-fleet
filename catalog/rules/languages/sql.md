---
fleet-template: sql
fleet-source-version: 1
---
# Rule: SQL change guidance

Load when planning, changing, or reviewing database schema or data changes. This is dialect-aware guidance, not a deployment profile: adapt it to the target engine and the repository's established migration mechanism.

Disposition: partial extraction — change completeness and verification kept, pipeline and tooling specifics excluded.

## Rules
- Make type, nullability, key, and relationship choices explicit and compatible with the target engine and existing contracts. No universal surrogate-key type, generated-value strategy, soft delete, audit columns, or fixed string/date types.
- Design indexes against actual predicates, joins, sorting, and workload; inspect representative plans when claiming performance. Do not mandate an index on every foreign key and do not order composite keys by selectivity alone.
- Account separately for schema changes and required data/backfill changes. Preserve data and required rolling-deployment compatibility; verify the migration path against the target engine and the repository's established migration mechanism.
- Make rerun behavior explicit for scripts intended to be repeatable; do not impose idempotency on every once-only migration. Include verification and failure/recovery expectations appropriate to the change.

## Scope and exceptions
Applies to the target's database changes. Excluded source assumptions, never carried over: schema-layout maps, reference-table bootstraps, project/deployment pipelines, IDE or CI steps, and fixed migration filenames. No single dialect's syntax is normative for other engines. The target adaptation must name its engine, migration tool, and how repeatable versus once-only scripts are distinguished.

## Verification
Review the migration against a representative database: schema applies cleanly, backfill preserves data, rollback or recovery is stated, and claimed index effects are backed by an actual plan. Flag engine-specific behavior against the target engine's documentation instead of asserting it.

## References
Use the target rule index and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
