---
fleet-template: shared-package-consumers
fleet-source-version: 1
---
# Rule: Shared-package consumer verification

Load when changing a reusable package or component consumed by other applications. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: consumer-based verification and host contracts; exclude Vue, local file dependency assumptions, and project commands.

## Rules
- Identify actual consumers and their supported integration contracts, including host plugins, configuration, styles, and build assumptions.
- Run the package’s existing checks where available. When no standalone build exists, verify through consuming applications instead of inventing a package build merely to claim success.
- Select affected consumers using evidence. If multiple host configurations differ, cover those relevant differences or explicitly report the uncovered consumers.
- Check the real consumption mode: source linkage, workspace dependency, or packaged artifact. Success against linked source alone does not establish published-package correctness.
- Keep shared contracts explicit; a dependency available in one host must not silently become a requirement for every consumer.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Run the narrowest relevant consumer builds/tests and runtime checks for host-dependent behavior. Record consumer, configuration, consumption mode, and result. An isolated package test is not integration proof; distinguish structural tests from observed runtime behavior.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
