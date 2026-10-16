---
"@chankov/agent-fleet": patch
---

Replace continuation quotas with supervision. Dispatch, research and review-round counts and active time stay visible, but no tier stops authorized work for a budget renewal; the watchdog supervises repeated calls and failures, and child deadlines, recycling and cancellation remain. Planner and plan review are optional at every size and risk; independent review and acceptance obligations are unchanged.

`max-dispatches-per-turn`, `max-research-per-turn` and `turn-wall-time-s` are ignored with a warning and flagged by `doctor`; delete them from `.ai/agent-fleet-overrides.md`. The `/af-budget-continue` command is removed because no budget can refuse work any more. Completed independent reviews of unchanged scope are reused, and older successful tool results are projected to exact references in batches so the model view stays prompt-cache stable.
