---
"@chankov/agent-fleet": patch
---

Scope herdr team workspace labels to the checkout so the same team can run from multiple repos/worktrees at once. Previously `just hub-team <team>` always labeled its workspace `pi-hub-<team>`, so launching the same team from a second repo/worktree failed with `herdr workspace "pi-hub-<team>" already exists`. Labels are now `<worktree-tag>-<mode>-<team>` (e.g. `wt2-hub-plan`, `end2-peers-docs`), where the worktree tag is the last dot-segment of the checkout directory's basename (`main.wt2` → `wt2`, `ringithub.end2` → `end2`, a plain `agent-fleet` checkout → `agent-fleet`). `team-up`, `hub-team`, `conductor`, and `team-snapshot`/`team-down`/`team-resume` all derive the tag the same way, so snapshot/resume still target the workspace they created. The `--project <name>` flag remains a separate axis for coms-pool scoping.
