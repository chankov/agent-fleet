---
"@chankov/agent-fleet": minor
---

`just fleet peer <name>` now launches the peer in a Herdr pane of its own, and can launch any kind of peer — including Claude Code.

**Behavior change:** `just fleet peer <name>` used to turn the *calling terminal* into a pi peer. It now opens a pane instead. Pass `--here` for the old behavior; the command it runs there is byte-identical to before.

Launching a Claude Code peer previously meant declaring it in `.pi/agents/peers.yaml` and running `just fleet team <preset>`, which builds a whole workspace. There was no way to say "give me one more agent, next to what I already have".

- The **name decides the shape**: a name declared in `peers.yaml` keeps its `runner`/`model`/`extensions`/`env_file`; a name matching `agents/<name>.md` becomes that guarded persona peer; anything else is the identity-only Fleet Core peer this command always launched. `--runner claude-code` needs no manifest entry at all. Note the second rule also changes meaning for existing invocations — `just fleet peer architect` is now the architect persona peer, because `agents/architect.md` exists. `--no-persona` forces the plain shape back.
- **Placement**: inside a Herdr pane it splits *that* pane (`--direction right|down`); outside Herdr it creates a single-pane workspace labelled `<worktree-tag>-peer-<name>`, refusing to clobber an existing one; `--here` runs it in the calling terminal.
- New flags: `--runner pi|claude-code`, `--persona`, `--no-persona`, `--model`, `--extensions`, `--direction`, `--here`, `--dry-run`. `--browser` now also works on a persona peer, where it adds `chrome-devtools-mcp`. Raw pi arguments move behind a `--` separator (`just fleet peer architect --here -- --session …`).
- **Nothing is silently dropped**: a flag that cannot apply to the resolved peer shape is an error, not a no-op — `--all-extensions` on a persona peer, `--persona` on a Claude Code peer, a mistyped flag, or a pi flag that forgot its `--`.
- A pane launch waits (bounded) for the peer to register in the coms pool and exits non-zero with the pane's last output when it never does — the same "failed, not slow" policy `herdr_spawn_peer` uses.
- `--dry-run` prints the resolved plan and placement without touching Herdr, and never reads `env_file` values.

Pure logic lives in `scripts/lib/peer-launch.ts` under `node --test`; the Herdr wiring is `scripts/peer-launch.ts`, reusing the existing command builder (`peerCommand`) and pane-launch helper so hub spawns, team spawns, and CLI launches stay one behavior.

`spawned-peers.js` (pane launch + readiness policy) moves from `.pi/harnesses/agent-hub/` to the shared `.pi/harnesses/lib/`, because the fleet scripts are installed into target projects that may not have selected the `agent-hub` harness. Both new scripts are added to `companion-manifest.json` so guided setup installs and refreshes them with the rest of the runtime closure.
