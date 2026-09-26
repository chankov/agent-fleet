---
fleet-template: authorization-before-effects
fleet-source-version: 1
---
# Rule: Authorization before side effects

Load when changing resource mutations, uploads, deletions, or background actions. Adapt to accepted target policy; this template is not automatically adopted policy.

Disposition: retain portable authorization invariants; exclude project helpers, domain types, API-key requirements, prescribed layers, and provider defaults.

## Rules
- Resolve the actual resource and requested operation through trusted target data; do not treat a supplied identifier as proof of permission.
- Verify authorization before mutations or other externally visible side effects. Read only the metadata needed for authorization before exposing protected resource content.
- Deny when required ownership or permissions cannot be established, including unrecognized resource types. Follow the target's established denial contract without leaking protected details.
- Enforce checks at the target's trusted execution boundary, including background or alternate entry points; a hidden UI control is not an authorization check.
- Where authorization state can change between checking and writing, use the target's transaction, locking, or conditional-write mechanism to maintain the required invariant. Do not prescribe one concurrency mechanism universally.
- Reuse accepted access-control policy and explicit exceptions; this rule does not grant access or authorize operational execution.

## Scope and exceptions
Apply to the target's relevant protected resources. Bind identity, ownership, denial, and privileged-access exceptions to explicit local policy. Unresolved security decisions require acceptance before normative apply.

## Verification
Test allowed and denied actions, unknown resource types, and failures to resolve ownership. Assert that denied actions produce no mutation or queued side effect. Check alternate execution paths and relevant concurrency cases; report untested invariants.

## References
Use the target policy index and existing access-control contracts and checks. Keep permission-before-effect checks distinct from tenant-scope propagation; load both when applicable.
