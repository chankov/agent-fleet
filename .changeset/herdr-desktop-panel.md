---
"@chankov/agent-fleet": minor
---

Add the `agent-fleet-herdr` Hermes Desktop plugin: a read-only panel listing live Agent Fleet sessions grouped by coms project, joined to herdr pane state by peer name, surfacing the agents that are waiting for a human answer. Ships both halves (Electron pane + FastAPI backend), a shared `scripts/install-hermes-plugin.sh` installer, and `docs/hermes-desktop-plugins.md` describing the plugin contract and its failure modes.
