---
"@chankov/agent-fleet": patch
---

Serialize stale writer-lease recovery so competing local processes cannot both acquire the same writer lease. Keep a bounded fail-closed response when the guard is abandoned, and add a native two-process regression test.
