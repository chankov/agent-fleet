---
"@chankov/agent-fleet": major
---

Install the whole fleet runtime under `.pi/`, leaving a workspace with five root entries instead of ten.

A `--preset full` install used to scatter 90 files across `scripts/`, `agents/`, `hermes/`, `docs/` and `.claude/hooks/` at the root of the project it was installed into. They now land under `.pi/agent-fleet/` (`scripts/`, `hermes/`, `hooks/`, `docs/`) and `.pi/agents/personas/`, so a fresh install leaves `.agents/ .ai/ .pi/ justfile` plus your `.env` and nothing else. `.agents/skills/fleet-session-client/` deliberately stays where it is — that path is the external Codex/ChatGPT client's own discovery convention, not ours to move.

**The old files are retired for you.** Changing where an item installs changes its binding, and `setup` already removes recorded files that leave a binding — byte-identical copies only. A file you edited is kept, becomes yours, and is reported by name; `verify` now summarises a relocation in one finding ("19 item(s) moved: 111 old file(s) to remove, 2 kept") instead of one finding per path, with the full list still under `items[].obsoleteFiles`. Run `agent-fleet setup` once and the move is done; the state file's `schemaVersion` goes 1 → 2 as the marker for it.

Two things worth knowing:

- **Personas.** They install to `.pi/agents/personas/<name>.md`. `agents/` and `.claude/agents/` remain yours and are still scanned *first*, so a persona you wrote keeps overriding ours; if one of your copies of a fleet persona survives the upgrade, `verify` says so rather than letting it silently shadow the installed one.
- **The Claude Code bridge Stop hook.** It moves from `.claude/hooks/` to `.pi/agent-fleet/hooks/`. Claude Code finds hooks only through `.claude/settings.json`, where the command is a free-form shell string, so nothing breaks until you re-point it — `setup` now prints the snippet with the new path. Nothing installs under `.claude/` any more.

Three guards keep the layout from drifting back: every relative import in the repository is resolved against disk, shipped code and data may not name a retired root, and the markdown that installs into a workspace — the part agents read and act on — is checked for stale paths too.
