---
"@chankov/agent-fleet": patch
---

Replace Agent Hub's double-confirmation budget UX with one localized Yes/No `ask_user` confirmation. Accepted turn continuations renew the current turn in-place; accepted task continuations open an audited tranche while preserving task tier, assertions, capability packs, blockers, label, and progress. Exclude human `ask_user` wait time from both turn and task active-time clocks. Remove the redundant `/af-new-task` slash command; genuinely different work still resets through `set_task_tier(new_task: true)`. Add a visible inline `m` model picker over Fleet Detail logs that exposes every model Pi currently reports as available and applies the choice to a local specialist, research helper, or nested delegate's next run without interrupting current work. Normalize legacy and Kitty keyboard sequences so arrows and paging keys navigate the picker consistently.
