---
"@chankov/agent-fleet": patch
---

Keep the Hub's acceptance assertion ledger across reload and resume: committed ledger changes are journaled as task-bound session entries and restored only for the same task, older sessions migrate their last typed `set_assertions` as open declarations without proof, and an operator current-state review that cannot register its candidate now names the exact refused qualifier and the permitted next step.
