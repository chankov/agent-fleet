---
"@chankov/agent-fleet": patch
---

Documentation now matches this release throughout.

- README, getting-started and `just fleet help` say that a flow runs on the current branch unless `--branch` is given.
- Guides no longer show removed commands and flags (`just fleet --agents/--peers`, `/af-agents`, `just fleet peer --browser`, `/compound`), and point at `setup` instead of the deprecated `update`.
- The setup guide moves the watchdog System 1 opt-in to `consumers.watchdog.mode` in `.ai/system1.json`, and drops a `version` key from the proactive review examples that made the section invalid.
- The Hermes guides say the npm package carries the plugin and skill sources (only the install script is repo-only), and the watchdog skill uses its installed script path.
