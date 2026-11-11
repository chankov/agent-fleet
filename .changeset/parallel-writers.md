---
"@chankov/agent-fleet": minor
---

Builders can now run in parallel on the current branch. Dispatch each writer with `parallel: true` and a scope of exact existing files or directories: the Hub runs it under the OS write sandbox confined to that scope, refuses a writer whose scope overlaps a running one, and attributes to each writer only the changes inside its own scope. Without the flag, writes are now sequential: a writable dispatch (including a bash-capable reviewer) is refused while another writer runs, where previously both ran with uncertain attribution.
