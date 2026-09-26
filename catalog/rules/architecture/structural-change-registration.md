---
fleet-template: structural-change-registration
fleet-source-version: 1
---
# Rule: Structural-change registration completeness

Load when adding, moving, renaming, or removing files that participate in discovery, packaging, or runtime registration. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: registration and delivery consistency; exclude project manifests, aliases, deployment providers, and prescribed folder layout.

## Rules
- Identify the file’s actual registration and delivery surfaces before a structural change: imports, exports, manifests, aliases, bootstrap entries, dynamic discovery, asset pipelines, and consumers where applicable.
- Update affected references and registrations together. Do not create registrations for systems the target does not use.
- Distinguish generated registrations from authoritative sources; update the owning source and regenerate through the established mechanism rather than hand-editing generated output.
- For removal, resolve remaining consumers and remove obsolete registrations. For moves, check path case and relative references as well as static imports.
- Preserve unrelated configuration and registrations; structural cleanup is not authorization to reorganize the whole repository.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Search for stale old paths and verify new entry points with available lint/build checks. Exercise relevant runtime discovery and inspect the packaged artifact when delivery is affected; compilation alone does not prove registration or packaging correctness. Report untested surfaces.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
