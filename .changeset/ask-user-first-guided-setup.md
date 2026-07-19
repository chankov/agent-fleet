---
"@chankov/agent-fleet": minor
---

Rework the guided-workspace-setup flow around the `pi-ask-user` widget: an Express question can resolve the whole install menu in one prompt, each group opens as a single-select quick screen with drill-in chunks only behind Customise, removal moves to an explicit "Remove some…" selection (the widget has no pre-checking), and every screen obeys a hard budget (≤ 9 options, ≤ 8 context lines) so nothing overflows the terminal. Doctor findings, overrides, method, and the confirm+installer-cleanup question all become native widget prompts; the old table format survives only as the no-widget fallback. The claude-code/opencode setup commands and doctor prompts mirror the same contract.
