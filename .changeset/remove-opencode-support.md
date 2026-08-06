---
"@chankov/agent-fleet": minor
# release: keep-bump
---

Remove OpenCode support. OpenCode is no longer a recognized agent for any skill,
persona, command, or harness. (This change left `claude-code` and `pi` as the
install targets; a later change in the same release removes `claude-code` too,
leaving pi as the only one.)

**Breaking for OpenCode workspaces.** `--agent opencode` is rejected by every
CLI verb, and the installer no longer knows the `.opencode/` paths, so it can
neither install into nor clean up an OpenCode workspace. Anyone with an
existing OpenCode install should delete `.opencode/agent/`,
`.opencode/skills/`, `.opencode/commands/`, and `.opencode/orchestrate-teams.yaml`
by hand before upgrading, then run
`npx @chankov/agent-fleet@latest setup --preset default --features none --yes`
for pi. Step-by-step: `docs/MIGRATION-agent-fleet.md`.

What changed:

- `detect-agent`, `manifest`, `transform-persona`, `bootstrap`, and `doctor`
  drop every `.opencode/` target path and the OpenCode persona transform
  (`mode: subagent` + tool denials).
- `install-manifest.json` regenerated: 101 items, no `opencode` bindings.
- `.opencode/` and `docs/opencode-setup.md` deleted from the package; the
  `opencode` keyword removed from `package.json`.
- `/compound` is gone as an installable command — it only ever shipped as an
  OpenCode command file. Invoke the `compound-learning` skill directly on
  Claude Code; pi keeps `/af-compound` via the `agent-hub` harness.
- Docs updated across README, AGENTS.md, CLAUDE.md, and `docs/`.

`.versions/<x.y.z>/` snapshots are left untouched — they are the record of what
each past release actually shipped, and the version-aware update flow diffs
against them.
