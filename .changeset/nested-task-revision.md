---
"@chankov/agent-fleet": patch
---

A task can now be proven in a workspace whose root is a plain folder holding nested repositories (for example `rin-docs/` and `ringithub/`). The Hub took the task's revision from the workspace root, which in such a workspace has none, so `update_assertion` refused every proof with "process obligations are open: review" even after a passing review, `/af-recover` could never clear an attempt, and a retry after a failed verification was never released. The revision now covers each nested repository that holds a declared path or a changed task file, whole: any change in such a repository makes earlier review and acceptance stale, while a change in another nested repository does not. Each recorded review, acceptance and plan keeps the repositories its revision covered and is checked against them, and a task file outside them still keeps the review open. A workspace whose root is itself a repository behaves exactly as before.
