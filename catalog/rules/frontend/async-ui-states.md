---
fleet-template: async-ui-states
fleet-source-version: 1
---
# Rule: Complete asynchronous UI states

Load when changing UI request handling, loading indicators, or error states. Adapt to the target's accepted contracts and tooling; this template is not automatically adopted policy.

Disposition: client-contract checks and complete state transitions; exclude Vue globals, endpoint formats, alert libraries, and project response shapes.

## Rules
- Verify the actual client method and response contract before use; do not infer method names from another library.
- Cover both synchronous request-creation failures and asynchronous rejection. Promise rejection handlers alone cannot catch a throw before the promise exists.
- Ensure every applicable completion path leaves loading state and produces the target's appropriate success, empty, error, or cancellation state.
- Follow existing request-ownership and cancellation conventions so stale requests do not overwrite newer results or clear their loading state.
- Handle recognized errors through the target's existing error contract and provide an appropriate fallback for unknown failures. Do not expose raw sensitive responses.
- Keep shared components independent of application-only clients unless that dependency is an explicit component contract.

## Scope and exceptions
Apply only to the relevant target surfaces. Preserve explicit local exceptions with scope and rationale; unresolved policy choices require acceptance before normative apply.

## Verification
Exercise synchronous throws, rejected requests, successful empty and populated results, and overlapping requests where supported. Observe visible loading and error behavior in runtime UI checks; unit tests alone do not prove the rendered experience.

## References
Use the target rule index, applicable contracts, and existing checks. Bind references during adaptation.
