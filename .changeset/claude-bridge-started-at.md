---
"@chankov/agent-fleet": patch
---

Fix `started_at` on bridged Claude Code peers, which reported an uptime of at most 30 seconds.

`scripts/coms-claude-bridge.ts` rebuilt its entire registry record on every 30s keepalive, and the builder set `started_at: nowIso()` — so the field never held the start of anything and the Hermes fleet panel showed every bridged Claude pane as freshly started, forever. This is the third copy of the bug that Phase 1 of the fleet-observability work fixed for the two pi harnesses; the bridge now reuses that same `buildLiveRegistryEntry()` instead of keeping its own. Registration captures `started_at` once; the keepalive carries it forward and moves `heartbeat_at`.
