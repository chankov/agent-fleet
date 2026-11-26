---
"@chankov/agent-fleet": patch
---

Teams and peer groups are gone: the Hub always has the three roles and all eleven practices, and each peer starts on its own.

- Removed native teams (`.pi/agents/teams.yaml`, `/af-agents-team`, `/af-agents-add`, `/af-agents-drop`, `/af-agents-save`, the `team_adjust` tool and `--agent-team`). The operator prompt lists the roles and the practice catalog instead.
- Removed peer groups and `.pi/agents/peers.yaml`, `just fleet team …`, team snapshots and resume. `just fleet peer <name>` takes `--runner`, `--model`, `--read-only` and `--env-file`; a pi peer always loads `chrome-devtools-mcp` except a read-only one. `just fleet --herdr` and `just fleet conductor hermes` run on a new single-pane launcher.
- `dispatch-policy.yaml` routes are keyed by role with a distinct `peer:` address (`reviewer: { peer: claude-reviewer }`); parallel instances use their role's route.
- Per-practice models: role files declare `practice_models:`, and overrides (`model.<role>.<practice>`), profiles (`editor.planning`) and `/af-agent-model <role>.<practice>` can change them; the first practice with a choice wins and the run records the source. The retired personas' models are kept as role-file defaults; the researcher uses one stronger model.
- A busy reviewer gets an automatic independent instance (`reviewer--p2`); `dispatch_agent` accepts `after: [instances]` to queue an assignment until its dependencies settle.
- Review closure records who authored each changed file and refuses self-review, including the same coms peer after a role change or a restart (a peer is its address, whatever its session). The check runs before the review starts: an auto route that would reach an author runs a native reviewer instead, and an explicit coms backend or `fallback: none` is refused with nothing launched. Only a fresh verdict covering the whole change at the integrated revision closes it, and follow-up reviews receive the previous findings and the delta.
- The operator prompt asks the Hub to check each delegate's evidence and follow up on gaps before it reports.
