---
"@chankov/agent-fleet": minor
---

The Hub operator now delegates on its own judgment. Its delegation tools (`dispatch_agent`, `spawn_research`, `team_adjust`) are always available instead of appearing only when a request mentions delegation. The prompt lists every installed agent; dispatching one outside the active team adds it automatically, and `team_adjust` is no longer tier-gated or capped. A "When to delegate" section asks for parallel research by default and an independent review of non-trivial changes, and local model concurrency limits are shown with their live usage. A new `poll_panel` tool lets the operator ask the model panel for a decision (architectural choices, uncertain diagnoses), sharing its implementation with `/af-poll`.
