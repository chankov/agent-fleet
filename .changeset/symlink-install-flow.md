---
"@chankov/agent-fleet": minor
---

First-class symlink installs: remembered method, kept installer, symlink-safe script runs.

- `guided-workspace-setup` now reuses the `method:` recorded in `.ai/agent-fleet-setup.md` instead of re-asking copy vs symlink on every run (asked only on first install; overridable in the Step 9 summary), and a recorded `keep-installer: true` skips the installer-removal offer entirely — the summary just confirms the commands stay.
- The `justfile` runs the fleet TS scripts through a `node_ts` variable that adds `--preserve-symlinks --preserve-symlinks-main`. Without them, a symlink install (targets linked into the project-scoped `.pi/npm/node_modules/@chankov/agent-fleet` package) breaks: Node realpaths `scripts/*.ts` into `node_modules/`, where `--experimental-strip-types` is refused. Copy installs are unaffected — the fleet scripts import only relative paths and node builtins.
