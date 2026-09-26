---
fleet-template: behavior-preserving-refactoring
fleet-source-version: 1
---
# Rule: Behavior-preserving refactoring

Load when refactoring existing behavior without an accepted functional change. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: preserve observable behavior during refactors; exclude controller return types, attribute ordering, naming suffixes, and mandated layers.

## Rules
- Establish the current observable behavior before restructuring: inputs, binding, validation, outputs, errors, permissions, call order, and side effects.
- Preserve existing behavior unless a functional change is explicitly accepted. Stricter validation is a behavior change, not automatically a safe cleanup.
- Account for every affected branch and side-effect call. Moving mapping or orchestration must not drop notifications, audits, or other required effects, or change their order where significant.
- Verify that a replacement helper or service actually owns the behavior being delegated; do not assume a matching name means equivalent effects.
- Remove dependencies and helpers only after checking their remaining consumers, including registration or indirect invocation. Keep intentional behavior changes distinct in the diff and verification.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Use characterization or regression tests for representative success, failure, validation, and permission paths. Check binding, serialization, side effects, and significant call order. Report uncharacterized behavior; passing compilation alone does not prove equivalence.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
