---
fleet-template: reporting-queries
fleet-source-version: 1
---
# Rule: Reporting query correctness and efficiency

Load when changing exports, reports, heavy read-only projections, or shared query loading shapes. Adapt to the target's accepted contracts and tooling; this template is not automatically adopted policy.

Disposition: query semantics and efficient execution; exclude EF/LINQ syntax, mandatory tracking modes, and prescribed layers.

## Rules
- Establish the intended result grain and aggregate meaning before changing query shape. Joins must not accidentally multiply rows or inflate totals.
- Use an existence test when only eligibility matters, where supported; validate semantics rather than mechanically replacing every join.
- Avoid per-row queries and unnecessary early materialization. Push filtering and aggregation to the data engine where supported and appropriate; inspect actual translation instead of assuming ORM behavior.
- Select required data and use the target's established streaming or batching approach for large outputs. Do not mandate a single in-memory materialization for every export.
- Apply required ordering before slicing; include a deterministic tie-breaker where stable ordered results are required.
- Keep presentation formatting at the target's accepted boundary, without importing a specific repository or mapper architecture.

## Shared-query change isolation
- Inspect all known callers before expanding a shared query. Filters, ordering, loading shape, tracking, projection, and materialization are part of its effective contract, not just its signature.
- Prefer a purpose-specific query or minimal projection when only one use case needs additional data. Execute additional work only on paths that need it; do not replace broad loading with per-row queries.
- An intentional shared-query expansion needs a caller-wide rationale and representative evidence. Convenience for one caller is not sufficient; resolve unclear performance or ownership trade-offs explicitly.
- Preserve existing read/write semantics and required consistency boundaries when splitting queries. Do not introduce an ORM upgrade or unsupported API simply to conceal the cost of an expanded query.

## Scope and exceptions
Apply only to the relevant target surfaces. Preserve explicit local exceptions with scope and rationale; unresolved policy choices require acceptance before normative apply.

## Verification
Use fixtures with duplicate reference rows, empty results, and representative aggregates. Inspect query counts, generated queries or execution plans where available; bind performance checks to existing target budgets rather than inventing thresholds.

For shared-query changes, verify unaffected caller paths retain their loading behavior and extra queries are conditional. Inspect generated queries or command counts and representative performance where feasible; mocks and green builds alone do not establish database performance. Report unmeasured effects.

## References
Use the target rule index, applicable contracts, and existing checks. Bind references during adaptation.
