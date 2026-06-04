---
"@chankov/agent-skills": minor
---

Add the `agent-hub` pi harness — an `agent-team` dispatcher with an embedded `coms` P2P layer, plus its recipe family and reusable peer manifest.

The dispatcher is now itself a coms peer: it carries the `coms_*` tools, `/handoff <peer>` to delegate a self-contained brief, `/coms` for the message log, peer-as-subagent dispatch, and `--name/--purpose/--project/--color/--explicit` identity flags, with graceful degradation when the coms endpoint can't bind. New `just` recipes:

- `just hub` — the dispatcher with embedded coms (accepts the coms identity flags).
- `just hub-solo` — the hub without the coms layer (fixed specialists + research only, lighter).
- `just peer <persona> [name] [model]` — a single reusable coms peer (coms + compact-and-continue + a persona under `.pi/agents/`).
- `just team-up <team>` / `just team-up-dry <team>` — spawn every peer of a team from `.pi/agents/peers.yaml` into tiled tmux panes (dry-run prints the resolved commands without launching).

Adds `.pi/agents/peers.yaml` (reusable peers grouped into named teams), starter `architect` and `releaser` peer personas, `scripts/team-up.ts`, and an `agent-hub` row in the pi-extensions catalog.
