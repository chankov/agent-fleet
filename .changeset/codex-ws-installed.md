---
"@chankov/agent-fleet": patch
---

In a workspace with Fleet copied into it, the Codex daemon connection uses the pinned `ws` from the workflow runtime dependencies in `.pi/agent-fleet/scripts`. `setup --allow-exec` or `just fleet deps` installs them. A new installed-layout test checks this, and also checks that the Hub still loads before they are installed. If a Codex connection reports `CONNECTION_ERROR` after a setup without `--allow-exec`, run `just fleet deps`.
