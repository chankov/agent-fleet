---
"@chankov/agent-fleet": patch
---

Fix `herdr_spawn_peer`: it opened panes without ever launching the peer.

herdr's `pane.split` takes no `command` — a split always opens a plain shell — and the server silently ignores unknown params. agent-hub passed `command: argv` to it, so every hub-spawned "peer" was an empty shell pane with the right label, the tool reported success, and the readiness wait then timed out on a peer that had never started. `just fleet team` was unaffected because it launches through `layout.apply`, whose pane nodes do carry an argv.

- The spawn now splits, waits for the new pane's shell prompt, and types the command line (text and Enter sent separately — bash bracketed paste swallows a newline inside sent text).
- Spawned peers join **this session's coms project pool** instead of always `default`, which had put them in a pool the hub cannot see.
- A name declared in `.pi/agents/peers.yaml` keeps its declared `runner:`, `extensions:`, and `env_file:`, so spawning `code-reviewer` produces the peer the fleet defines rather than a plain pi persona.
- Hub spawns honor the stale-OAuth spawn stagger that team launches already used, so back-to-back spawns cannot lose the credential lock race.
- `peer_ready: false` now returns the pane's last output and states that the peer failed to start; the orchestrator persona and hub guidance say not to send to it or spawn around it.
- `paneSplit` no longer advertises a `command` param, and the client test pins `pane.split` to its real wire shape.
