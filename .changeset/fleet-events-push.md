---
"@chankov/agent-fleet": minor
---

Push fleet events to the herdr pane over a WebSocket instead of waiting for the next poll, without giving up the poll.

`WS /api/plugins/agent-fleet-herdr/events/stream?after=<seq>` serves the same ring buffer `GET /events` already serves — same events, same sequence numbers, same cursor — as a first frame carrying the backlog past `after`, then one frame per batch as it happens, and an empty `keepalive` frame every 20s of silence. This is the plan's Phase 5, and it lands last on purpose: latency was only worth spending on once Phases 1–4 had made something worth pushing.

**The poll is the contract; the socket is the accelerator.** `ctx.socket` is a documented no-op on OAuth remotes and gives its caller no close event, so the pane never stops polling — it steps `/events` down from every 5s to every 30s while frames are arriving and back up the moment they stop (`shouldPollEvents`). Nothing has to detect a broken socket, because nothing was ever switched off, and the 30s floor is also what recovers a batch the stream dropped. Both feeds run through one handler and one cursor in the renderer, which is what makes them interchangeable rather than additive: `presentEvents(payload, primed, after)` filters by `seq`, so the same event delivered by both is a wasted frame instead of a duplicate toast, and a frame that overtakes another cannot rewind the cursor.

**The route has to authenticate itself, which was not obvious.** Every gateway middleware — the auth gate *and* the one that 404s a plugin missing from `plugins.enabled` — is registered for the `http` scope, so a WebSocket upgrade reaches a plugin router with nothing checked at all. `_socket_gate()` re-runs the gateway's own `_ws_request_is_allowed` / `_ws_auth_ok`, looked up in `sys.modules` rather than re-imported, plus the enabled check. **Unresolvable means refused**: a Hermes that renames those functions gets no stream and a pane that keeps polling, because the alternative is an upgrade quietly converting this into an unauthenticated event feed.

**`EventStream` subscribes before it reads the backlog.** The other order has a hole in it — an event landing between the two would be in neither — and this order can only produce a duplicate, which the cursor filter drops. Its per-socket queue is bounded at 64 batches and drops rather than growing without bound; the batch arrives late via the poll instead of never, which is the second reason the poll stays. `Watcher.subscribe()` fans batches out to live listeners on whatever thread observed the snapshot, under the same rule as the outbound sinks: a listener that raises costs a line on stderr and never stops the watcher.

`/capabilities` gains `events_stream: true` — not a source, a version marker: backend routes mount at app construction, so the presence of that key is the honest answer to "has Hermes restarted since the plugin changed".

The optional half of the phase — replacing the `herdr agent list` subprocess with a JSON-lines socket client — is dropped on measurement rather than taste: seven runs of that command take 3.1–4.6ms, which at a 3s interval is not something a human can perceive, and the alternative is a second implementation of herdr's protocol in Python.
