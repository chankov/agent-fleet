---
"@chankov/agent-fleet": patch
---

In a workspace whose root is a plain folder holding nested repositories, the operator now sees it. Once a task uses a nested repository, the Hub's current-task state says that the root is not a Git repository, lists the nested repositories the task uses, asks for exact paths inside one of them, and notes that `run_flow` cannot run at that root. The list comes from the task's recorded review, acceptance and plan; the workspace is never scanned. A workspace whose root is a repository, or a task that has not touched a nested repository yet, shows nothing new.
