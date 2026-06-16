---
"@chankov/agent-skills": patch
---

agent-hub: dashboard cards now list running delegate children ahead of finished ones. Previously children rendered in spawn order and the `MAX_CHILD_ROWS` cap could hide live sub-agents behind already-completed ones; running delegates now sort first (spawn order breaks ties within each group) so an in-progress child is never the row that gets dropped.
