---
fleet-template: enum-semantics
fleet-source-version: 1
---
# Rule: Explicit enum semantics

Load when creating or changing enums, named codes, or their persisted and serialized representations. Adapt to the target's accepted contracts and tooling; this template is not automatically adopted policy.

Disposition: portable named-value and compatibility guidance; exclude project paths, mandatory suffixes, sequential numbering, and a universal zero member.

## Rules
- Prefer the existing named value over a magic number; use the target language's established representation rather than prescribing integer casts.
- Preserve persisted or externally serialized values. Reordering members must not silently change their meaning; make assignments explicit where the representation depends on declaration order.
- Follow accepted naming and placement conventions. Do not require sequential numbering, a name suffix, or an undefined zero member universally.
- Define how unknown values are handled at boundaries using the target contract; do not silently coerce them into a valid business value.
- Treat removal or reassignment of externally used values as a compatibility decision, with affected consumers and stored data identified.

## Scope and exceptions
Apply only to the relevant target surfaces. Preserve explicit local exceptions with scope and rationale; unresolved policy choices require acceptance before normative apply.

## Verification
Verify representative serialization round trips and stored-value mappings, including unknown values. Check compatibility against existing fixtures or published contracts; report unavailable evidence.

## References
Use the target rule index, applicable contracts, and existing checks. Bind references during adaptation.
