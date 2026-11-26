---
# release: keep-bump
"@chankov/agent-fleet": minor
---

The package ships three role definitions instead of the fourteen personas, and every guide describes roles and practices.

- `agents/` holds only `researcher.md`, `reviewer.md` and `editor.md`. Their catalogue ids stay `persona:researcher`, `persona:reviewer` and `persona:editor` (group "Agent roles"); the default preset installs all three, and installing the Hub always brings them in, so a single role cannot be uninstalled while the Hub stays.
- `setup` retires the old personas: an unedited installed copy is removed, an edited one is kept and becomes yours. Overrides and model profiles are never edited.
- `agent-fleet doctor` reports, read-only, every leftover definition file named for a retired persona and every key in `.ai/agent-fleet-overrides.md` or `.pi/agents/model-profiles.yaml` that names one (`model.builder`, `thinking.planner`, a profile's `builder:`), with its file and line. An unambiguous name gets the exact replacement (`model.builder` → `model.editor.implementation`); an ambiguous one shows the role and practice choices.
- `just flow build-test` runs the editor with the implementation practice and `just flow document` the editor with the documentation practice (documentation paths only, no shell). Each phase carries the assignment block and traces its role, practices and model source; the fix phase is now `editor-fix-N`.
- `docs/agents.md` is the role and practice catalogue, and `docs/MIGRATION-agent-fleet.md` section 6 maps each retired persona, team and peer-group command to its replacement.
