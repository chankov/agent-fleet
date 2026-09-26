---
fleet-template: established-ui-primitives
fleet-source-version: 1
---
# Rule: Reuse established UI primitives

Load when building or changing UI controls for which the target has shared visual primitives. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: reuse through verified component contracts; exclude mandatory Base components, icon libraries, CSS classes, and claims of automatic accessibility or performance.

## Rules
- Inspect existing primitives and their actual props, slots, events, semantics, and styling before introducing a parallel control.
- Prefer an established primitive when it meets the use case. If it does not, explain the gap and follow the target’s extension or exception policy rather than forcing reuse or adding a new library silently.
- Preserve supported component contracts and use documented customization points; avoid depending on incidental internal markup without an explicit reason.
- Do not assume a shared component is accessible merely because it exists. Verify labels, focus, keyboard interaction, and relevant states for the actual composition.
- Reuse does not require every native element to become a component. Retain native semantics and avoid wrappers that add no target-supported value.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Verify component inputs, emitted events, disabled/error states, and rendered accessibility behavior using existing checks and runtime observation. Inspect the consuming composition, not just the primitive’s isolated example. Report any checks not performed.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
