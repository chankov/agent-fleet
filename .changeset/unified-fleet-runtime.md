---
"@chankov/agent-fleet": minor
---

Unify Pi Fleet startup behind one guarded Agent Hub runtime. Bare `just fleet` now loads Fleet Core plus Agent Hub in operator posture, preserving direct coding tools and starting with an empty native roster. Use `--posture`, `--agents`, `--herdr`, `--peers`, `--project`, and `--no-coms` to select execution posture, native specialists, workspace topology, project scope, and communication capabilities independently.

Add live `/af-posture` switching, on-demand native roster growth, deterministic `dispatch_agent` routing through `backend: auto|native|coms`, and same-project dynamic Pi or Claude Code peer spawning through Herdr. `just fleet hub`, `just fleet team <preset>`, team `--no-hub`, and `--solo` remain accepted for one migration release and print their canonical replacements.
