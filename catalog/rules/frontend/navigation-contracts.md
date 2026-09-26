---
fleet-template: navigation-contracts
fleet-source-version: 1
---
# Rule: Navigation and URL consistency

Load when changing routes, navigation, or query-string handling. Adapt to the target's accepted contracts and tooling; this template is not automatically adopted policy.

Disposition: stable navigation contracts and reusable component boundaries; exclude Vue plugins, route paths, and project naming defaults.

## Rules
- Use the target's existing router and query utilities where applicable; inspect their contracts instead of introducing a parallel parser without need.
- Preserve established path and query parameter contracts for existing flows. Resolve intended compatibility changes explicitly.
- Follow accepted route naming conventions; do not import a universal kebab-case or no-hyphen rule.
- Prefer existing named routes for internal application navigation where supported. Keep shared components independent of an application's route table by using the target's established callbacks or URL inputs.
- Encode dynamic values through supported routing utilities. Handle navigation failures explicitly; suppress only a recognized benign duplicate-navigation condition when accepted locally, not every error.

## Scope and exceptions
Apply only to the relevant target surfaces. Preserve explicit local exceptions with scope and rationale; unresolved policy choices require acceptance before normative apply.

## Verification
Check direct navigation, refresh/deep links, query round trips with encoded values, and back/forward behavior as applicable. Verify shared consumers and distinguish runtime observations from static route checks.

## References
Use the target rule index, applicable contracts, and existing checks. Bind references during adaptation.
