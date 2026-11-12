---
"@chankov/agent-fleet": patch
---

The Hub no longer reports an active tool as unknown after tools change during a run. It recorded the tool catalog once when a run started, while `set_task_tier` activates the fleet tools later in the same run; every later `dispatch_agent` call was counted as an unknown tool, and after three calls the operator was told not to retry `dispatch_agent` for the task, so it fell back to raw `coms_send` reviews that never close a review. The catalog is now recorded for each model request, so a call is judged against the tools that request offered. The operator guidance also says that review goes through `dispatch_agent` (with `backend: "coms"` for a peer reviewer), that a raw `coms_send` reply is never review evidence, and that the operator's own edits close review through a native `operator-current-state` review of the exact files.
