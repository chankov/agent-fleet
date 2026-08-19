---
"@chankov/agent-fleet": patch
---

Replace Agent Hub's double-confirmation budget UX with one localized Yes/No `ask_user` confirmation. Accepted turn continuations renew the current turn in-place; accepted task continuations open an audited tranche while preserving task tier, assertions, capability packs, blockers, label, and progress. Exclude human `ask_user` wait time from both turn and task active-time clocks. Remove the redundant `/af-new-task` slash command; genuinely different work still resets through `set_task_tier(new_task: true)`.
