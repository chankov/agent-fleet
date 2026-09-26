---
fleet-template: trusted-tenant-scope
fleet-source-version: 1
---
# Rule: Trusted tenant scope

Load when changing tenant-scoped reads, writes, authentication context, or delegated processing. Adapt to accepted target policy; this template is not automatically adopted policy.

Disposition: retain portable authorization invariants; exclude project helpers, domain types, API-key requirements, prescribed layers, and provider defaults.

## Rules
- Derive authorization scope from validated identity and the target's trusted authorization context, not solely from client-supplied tenant identifiers.
- A client-supplied tenant selector may select only a scope already authorized for that identity. Cross-tenant administration requires an explicit policy and permission, never an implicit bypass.
- Propagate trusted scope through the target's service, data-access, and background-processing boundaries. Enforce resource ownership where data is returned or changed; authentication at the entry point alone is insufficient.
- Filter or verify resources through the actual tenant relationship. Deny when ownership cannot be established; do not infer ownership from naming or unrelated identifiers.
- Keep tenant context isolated between requests and jobs. Scope caches and lookups appropriately so one tenant cannot receive another tenant's data.
- Follow the target's accepted denial and privacy contract. Do not universally prescribe a status code or reveal whether an out-of-scope resource exists.

## Scope and exceptions
Apply to the target's relevant protected resources. Bind identity, ownership, denial, and privileged-access exceptions to explicit local policy. Unresolved security decisions require acceptance before normative apply.

## Verification
Exercise at least two tenant contexts: tampered selectors, cross-tenant resource IDs, authorized access, missing scope, and reused request/job or cache paths where applicable. Assert no cross-tenant data disclosure or mutation. Report gaps rather than treating authentication tests as isolation proof.

## References
Use the target policy index and existing access-control contracts and checks. Keep permission-before-effect checks distinct from tenant-scope propagation; load both when applicable.
