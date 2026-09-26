---
fleet-template: response-data-minimization
fleet-source-version: 1
---
# Rule: Response-data minimization

Load when designing or changing externally exposed responses or their intermediate projections. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: intentional field exposure and early minimization; exclude project DTO conventions, domain-specific field lists, and prescribed layers.

## Rules
- Identify the fields intentionally exposed by the accepted response contract. Prefer explicit selection to serializing internal objects wholesale.
- Where practical, exclude sensitive and internal-only fields from upstream projections and intermediate response objects rather than relying solely on a final mapper to remove them.
- Review nested objects, errors, metadata, and debug paths as well as top-level fields. Authorization to access a resource does not authorize disclosure of all its fields.
- Follow the target’s data classification and explicit exceptions. Do not ban legitimate personal-data responses universally; require an accepted purpose and exposure contract.
- Keep minimized projections aligned with required behavior and existing query boundaries; do not broaden shared queries or break unrelated consumers as a shortcut.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Assert both required fields and absence of prohibited fields for representative success and error responses, including nested data. Test the actual serialization boundary where available. Report unverified response paths; mapper unit tests alone do not establish end-to-end minimization.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
