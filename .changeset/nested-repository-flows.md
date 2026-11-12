---
"@chankov/agent-fleet": minor
---

Flows now work in a workspace whose root is a plain folder holding nested repositories. Hub `run_flow` takes an optional `repo` naming the one nested repository to scout. Without it at such a root, the call is refused without charging budget and names the repositories the task already uses. `repo` is refused where the root is itself a repository, in a session already bound to a target, and for any path outside the workspace. `just flow --worktree <repository>` already ran a flow inside a nested repository. It now has a per-repository quality command: `quality.<repository>:` under `## workflows` wins over `quality:` for a flow selected into that repository. A flow, `cleanup` or `merge` started at such a root without `--worktree` now refuses with the flag to pass instead of a raw Git error.
