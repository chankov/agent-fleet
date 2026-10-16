---
"@chankov/agent-fleet": patch
---

Remember identical approval dialogs within a task so the human is not asked the same exact question twice, and let a recorded exact-action delete approval cover the same delete. Only exact-action dialogs that showed the command record a decision; free-form `ask_user` answers are never stored or answered automatically, and commands containing control characters (an inner newline separates Bash commands) never count as inspection or as a covered delete.
