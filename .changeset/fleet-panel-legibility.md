---
"@chankov/agent-fleet": minor
---

Make a running fleet legible in the Hermes panel, and stop `started_at` from lying.

Both harnesses rebuilt their coms registry entry on every 30-second heartbeat with `started_at: nowIso()`, so the field never held the start of anything — a session running for two hours reported an age of a few seconds, and anything trying to show uptime was showing noise. The entry is now built by `buildLiveRegistryEntry()` in `.pi/harnesses/lib/coms-registry-entry.ts`, shared by the standalone coms harness and the copy embedded in agent-hub: registration sets `started_at`, the heartbeat carries it forward and moves `heartbeat_at` instead.

The `agent-fleet-herdr` panel forwards what it already had and derives what the renderer cannot. Rows now carry `uptime_s`, `heartbeat_age_s` and `stale` (the same 90s freshness rule the registry reader applies), plus `heartbeat_at` and the pane's `workspace_id`; the payload carries `herdr_panes`, the total pane count from herdr. All time arithmetic happens in the backend, which knows when the snapshot was collected — a `null` timestamp renders as nothing rather than `0s`.

That pane count is what finally explains `detached`: "herdr reports no panes at all" and "none of 7 herdr panes reports it" are different problems that used to be the same word. A stopped heartbeat outranks both, because it is a statement about the process rather than about our view of it. Rows also show context use, a non-empty queue and uptime, and a pending dispatch counts up on its own second-by-second instead of looking identical from the moment it is sent to the moment it answers.

New: `POST /sessions/{project}/{name}/focus` brings the workspace hosting a peer to the front. It takes `(project, name)` like the prompt endpoint, resolves the workspace server-side from a herdr answer taken now, and validates the id before it reaches argv. A `detached` peer answers 422 — it is still perfectly askable, since coms reaches its own socket, but there is no pane to bring forward.
