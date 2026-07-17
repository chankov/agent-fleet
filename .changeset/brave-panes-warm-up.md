---
"@chankov/agent-fleet": patch
---

Fix fleet panes spawning with every pi provider "unconfigured": simultaneous pi boots race on the `~/.pi/agent/auth.json` file lock when the stored OAuth token is stale (the refresher holds the lock across its network call, and losers silently boot with an empty credential store). `team-up`, `hub-team`, and `team-resume` now pre-warm: when a stale OAuth credential is detected, one pi pane starts immediately to refresh the token and the other pi panes are staggered via `AGENT_FLEET_SPAWN_DELAY` (honored by the `_peer`/`_peer-plus` recipes). Fresh tokens spawn with zero delay; `claude-code` runner panes never wait.
