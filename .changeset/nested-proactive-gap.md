---
"@chankov/agent-fleet": patch
---

The proactive snapshot no longer reports a Git failure for a workspace whose root is a plain folder holding nested repositories. When a configured `include` path lies outside every nested repository, the snapshot now records `include_outside_nested_repository` instead of `git_unavailable`, and the nested repositories stay observed. A workspace whose includes all lie inside nested repositories was already observed in full and is unchanged.
