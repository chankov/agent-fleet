---
"@chankov/agent-fleet": patch
---

Fold the package update check into Fleet Core: damage-control-continue schedules a shared helper at session start instead of loading `pi-extension:agent-fleet-update-check`. The banner now names `npx @chankov/agent-fleet@latest setup`, `--dry-run`, and the releases URL.
