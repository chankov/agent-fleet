---
"@chankov/agent-skills": patch
---

Load the hard-stop `damage-control` harness before `agent-hub` in the default `just hub` and `just hub-solo` recipes, and propagate it into spawned subagents: `agent-hub` now re-loads `damage-control` into every specialist and research helper via an explicit `-e` that survives their `--no-extensions`, so subagent tool calls (including `.env` and other secret reads) are checked against `.pi/damage-control-rules.yaml` instead of running unguarded. `damage-control` also now matches the `find` tool's `pattern` against zero-access paths, closing a gap where `find` could still locate secret files. Retire the `damage-control-continue` harness and recipe, hide the internal coms peer helper from `just --list`, and update the pi harness docs/setup guidance to describe the guarded hub launch and subagent safety scope.
