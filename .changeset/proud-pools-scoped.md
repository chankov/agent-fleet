---
"@chankov/agent-fleet": patch
---

Document the `--project` flag on every team recipe in the justfile and the README quickstart: scoping a team to its own coms pool (`just hub-team review --project af`) is what keeps teams launched from different repos out of each other's peer pool, and the bare `project=af` form is a just variable override that gets silently ignored (the team lands in the shared "default" pool and collides with other repos' peers — name suffixing like `code-reviewer2`, dispatches routed to the wrong repo's pane).
