---
"@chankov/agent-fleet": patch
---

`spawn_research` runs distinct questions in parallel. Each question is its own attempt, keyed by its normalized task, goal and expected result (case, punctuation and spacing ignored): the same question already in flight is refused as busy, and a failed or cancelled question is fenced for itself without blocking other questions.
