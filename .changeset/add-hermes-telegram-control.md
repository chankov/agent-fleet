---
"@chankov/agent-fleet": minor
---

Add `/set-hermes-telegram` (`/af-set-hermes-telegram` on OpenCode) and the deterministic `agent-fleet set-hermes-telegram` CLI. It installs/status-checks the profile-scoped `hub-liaison` skill with drift protection, atomic backup/replacement, tool and gateway verification, and explicit restart control, then starts or stops the Telegram `ask_user` bridge in a dedicated pane in the current Herdr workspace. Bridge sends are pinned to the verified Hermes profile instead of relying on the sticky default.
