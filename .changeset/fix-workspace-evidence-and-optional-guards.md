---
"@chankov/agent-fleet": patch
---

Fix workspace verification and remove unnecessary optional Damage-Control infrastructure blockers.

- Bind native test evidence to the same explicitly declared repository scopes used by acceptance, supporting workspaces containing multiple Git repositories while preserving whole-repository revision semantics for single-repository workspaces. Reject missing revision identities even when both sides report `unavailable`.
- Skip the optional D6 broker and physical-spawn registration when D6 is disabled and the task has no persisted hold or denial. Preserve existing denials, held approvals, revoked assignments, and baseline protection for dangerous operations and secret files. Disabled child adapters no longer add optional D6 result annotations.
- Report distinct child assessment errors instead of presenting transport, registration, or baseline failures as a generic authorization refusal. Prevent known internal registration and transport errors from globally latching unrelated delegation as an external blocker.
- Allow explicit retries after corrected no-launch preflight conditions, including scope mode changes and external-blocker acknowledgment, without weakening cancellation or unknown-effect recovery fences.
- Avoid protected-path and dangerous-command false positives in literal quoted `cat`/`tee` heredoc data followed by ordinary inspection commands. Retain conservative checks for executable or expanding heredocs, unknown programs, wrappers, assignments, executable paths, executable sed expressions, and actual protected file operands.
- Add regression coverage for multi-repository evidence, disabled-guard lifecycle and result handling, retry conditions, and heredoc classification; update architecture and Damage-Control documentation.
