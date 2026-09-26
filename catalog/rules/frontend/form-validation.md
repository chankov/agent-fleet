---
fleet-template: form-validation
fleet-source-version: 1
---
# Rule: Consistent form validation

Load when adding or changing form validation and input error display. Adapt to the target's accepted contracts and tooling; this template is not automatically adopted policy.

Disposition: data-aligned validation, submission guards, and actionable feedback; exclude Vuelidate, UI components, example limits, and source paths.

## Rules
- Use the existing validation mechanism and align validation with the actual data shape, including nested and dependent fields.
- Derive required fields and limits from accepted target requirements; do not copy example limits or impose a validation library.
- Revalidate before submission and prevent invalid submissions. Client-side validation does not replace authoritative server-side validation.
- Show actionable field errors using established interaction and accessibility conventions. Respect the target's touched/dirty or submission feedback policy rather than imposing universal blur behavior.
- Keep shared validators in their accepted owner; shared components must not import application-only validation modules.
- Keep displayed limits and messages consistent with the rules they describe, using existing localization where present.

## Scope and exceptions
Apply only to the relevant target surfaces. Preserve explicit local exceptions with scope and rationale; unresolved policy choices require acceptance before normative apply.

## Verification
Test valid and invalid submissions, untouched-field feedback, nested fields, and dependent-value changes as applicable. Check error association and rendered feedback with the target UI verification process; name checks that could not run.

## References
Use the target rule index, applicable contracts, and existing checks. Bind references during adaptation.
