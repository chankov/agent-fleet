---
description: Scan agent-fleet install targets for broken symlinks, stale persona references, and overrides-file problems, then offer repairs
---

Load and follow the `guided-workspace-setup` skill's repair path — without running the rest of the install flow. Use this when the user wants the repair pass on its own; `/af-setup-agent-fleet` offers the same thing as soon as it finds prior install state.

Run the CLI — do not walk directories or repair files yourself:

```
node <source-root>/bin/cli.js doctor --workspace <workspace> [--agent <agent>] --json
```

Resolve `<source-root>` from `<workspace>/.ai/.agent-fleet-bootstrap.json`, or this prompt's realpath if it is a symlink, or by asking. Never scan the filesystem for agent-fleet clones.

The report has two halves, and they are repaired differently on purpose:

- `repairs` — recorded items that are missing, dangling, or linked outside the source root. These are rebuilt through the same `apply()` path `install` writes with, so a repaired file is byte-identical to a freshly installed one.
- `findings` — what the install record cannot own: broken symlinks in a pre-engine workspace, stale persona names in `.pi/agents/*.yaml` (`reviewer` → `code-reviewer`, `red-team` → `security-auditor`), plus advisory ones. `overrides` and `yaml-shape` findings are **advisory**: report them with "edit by hand" and never fix them, because the fix is always a hand edit of the flagged file.

Print the two lists as text, then ask one `ask_user` single-select (or a plain text question without the widget) — *"Apply the suggested fixes?"* — and on yes re-run with `--fix`. An empty answer or a cancel applies nothing.

Exit codes: `0` nothing to repair, `2` repairable issues found (or advisories present, or a repair failed), `1` could not run. Report the counts the CLI returns; do not invent your own.
