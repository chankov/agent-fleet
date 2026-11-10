---
"@chankov/agent-fleet": patch
---

Add exact-target native Codex connection prepare/commit/status tools and a Fleet View chat-connections panel. New connection rights and notifications default to separate 12-hour leases, with mandatory read and optional send/approve; existing grants remain unchanged. Support explicitly reviewed renewal of an already active notification mapping without replacing its epoch or journals, while preserving exact-owner checks and no-replay handling.

Clarify that an explicit faithful user send to one selected read+send target needs no redundant second human confirmation, while technical prepare/commit, separate grants, human question responses, machine permission decisions and host approvals retain their safeguards. Preserve opaque question tool-call IDs through bounded canonical references without changing legacy addresses.

Add opt-in private-config-current-state verification using bounded private inputs, metadata/digests, capture-bound native checks and independent review rather than fake Git edits or exported configuration bodies. Document the 24-to-27-tool host rollout, managed runtime/skill updates, notification and restart limits, and remaining verification boundaries; publishing a patch does not activate delivery, refresh a host or grant rights.
