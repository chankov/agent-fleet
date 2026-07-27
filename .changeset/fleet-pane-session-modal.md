---
"@chankov/agent-fleet": minor
---

Replace the Hermes fleet pane's ask box with a per-session modal, and make the panel read-only for now.

Selecting a row used to fill in a composer at the bottom of the pane: an input, a Send button, and — squeezed into the header line next to it — the only other thing you could do, `Focus pane`. Sending is withdrawn for the moment, so what is left needed somewhere better than the bottom of a 300px column.

A selected row now opens a modal. It carries what the row has to truncate — purpose, model, directory, context use, queue depth, uptime, heartbeat age, and which herdr pane hosts it — and below that the actions available on that agent, which for now is exactly `Focus pane`. An action that is currently impossible stays visible and disabled with the reason beside it, because "why can't I focus this one" is the question the panel exists to answer: a `detached` row is a live session that no pane hosts, which is a different statement from an agent that cannot be reached. A session that dies while its modal is open reads `gone` rather than emptying out, since the selection is re-found in each payload rather than remembered.

`presentComposer()` is gone, replaced by `presentSessionMenu()` returning a list of actions — adding one is an entry in that list and a door in the renderer, not a new component. `POST /sessions/{project}/{name}/prompt` and the dispatch transcript behind it are untouched and still work; nothing in the pane calls them.
