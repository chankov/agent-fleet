---
"@chankov/agent-fleet": patch
---

Add an experimental opt-in ChatGPT Fleet session client for selecting existing Pi sessions, sending instructions with durable duplicate protection, and reading bounded activity, public task output and late replies. Include per-conversation resync/replay, a workspace skill and deterministic install/uninstall support. Pi remains independently running; idle chat wake and automated question answers are outside this client.

Fix Hub presence/monitor initialization for coms custom-message runs by subscribing to the common agent_start lifecycle event, so native child progress is visible before completion on that route too.

Fix transcript identity lookup after Pi reload/resume by selecting the latest complete coms boot in a bounded window, allowing late-result resync in the same conversation.

Remove the legacy Codex Remote conductor/control entry points, companion installation surface and service template from the package. Use the opt-in `chatgpt-client` feature with an already running Pi session instead. Package retirement does not stop or migrate existing host services; host cleanup remains a separate operator action. Existing workspaces should reconcile their desired features through the normal installer, preserving other selected features.
