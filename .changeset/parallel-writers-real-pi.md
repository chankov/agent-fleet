---
"@chankov/agent-fleet": patch
---

Parallel builders now start with real Pi. The write sandbox let no child create Pi's lock files, so every sandboxed child failed at startup (`EROFS` on `~/.pi/agent/trust.json.lock`); it now allows new lock entries in the Pi agent directory and the project `.pi` while keeping their existing contents read-only. A second `parallel: true` dispatch to a persona that is already writing now runs as its own instance (`builder--p2`) instead of being refused as busy, and an instance keeps its base persona's review meaning and tier gates.
