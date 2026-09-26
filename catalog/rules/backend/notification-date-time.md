---
fleet-template: notification-date-time
fleet-source-version: 1
---
# Rule: Notification date and time consistency

Load when formatting dates or times in email, in-app, or other notification channels. Adapt to accepted target policy and tooling; this template is not automatically adopted policy.

Disposition: centralized display formatting; exclude Nomenclatures constants, fixed formats, and assumed locale or time zone.

## Rules
- Use the target’s accepted date/time formatting mechanism instead of scattering hardcoded display formats across notification channels.
- Establish the intended locale and time zone from the notification contract. Do not silently rely on worker-machine defaults or invent a recipient preference.
- Keep equivalent notifications consistent across channels while respecting explicitly different audience requirements.
- Distinguish human-readable display formatting from machine-readable timestamps. Do not replace protocol or stored timestamp formats with a localized display string.
- Define missing locale/time-zone behavior through existing policy; ask when it is unresolved. Preserve the underlying instant when formatting for different recipients.

## Scope and exceptions
Apply only to relevant target surfaces. Preserve explicit local exceptions with scope and rationale. Unresolved policy choices require acceptance before normative apply.

## Verification
Test representative accepted locales and zones, date-boundary cases, and daylight-saving transitions where relevant. Compare equivalent values across channels and ensure machine-readable timestamps retain their contract. Do not copy a source project’s literal format string.

## References
Use the target rule index, accepted contracts, and existing checks. Bind references during adaptation.
