---
description: Guided setup — install agent-fleet artifacts into a workspace for a chosen coding agent
---

Invoke the `guided-workspace-setup` skill via the `skill` tool and follow it.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask. Confirm the coding agent (`opencode` here unless the user says otherwise).

The skill is a front-end over the `agent-fleet` CLI's installer engine: `verify --json` supplies the menu (groups, profiles, per-item state), and `install` / `upgrade` / `uninstall` / `doctor --fix` do every write. **Do not copy, symlink, or delete an install target yourself** — the CLI records ownership in `.ai/agent-fleet-state.json`, and anything written by hand is invisible to every later run. Personas land in `.opencode/agent/<name>.md` as generated files; the CLI handles that too. Artifacts install as copies; never ask copy-vs-symlink and never pass `--method`.

Two things are yours rather than the CLI's: drafting `.ai/agent-fleet-overrides.md` from a scan of the project, and the `pi-voice-stt` provider Q&A (pi workspaces only).

With a native select widget, open with the Express question backed by the manifest's profiles, then run group screens only on `Custom`, with drill-ins behind `Customise`. Without one, print a compact table and take a text reply. Option titles carry `<name> ★ [state]`; descriptions say what picking it does in plain words. Leaving an installed item unpicked keeps it — removal is its own explicit screen and runs `uninstall`. Cancel is a no-op everywhere except the final confirmation.

If `verify` reports findings or broken items, offer `doctor --fix` before the menu — a broken workspace makes the menu lie about what is installed.

Print the plan as compact action-grouped lines and wait for explicit confirmation before anything is written. Exit `3` from the CLI means conflicts: show the `.new` files it wrote and let the user decide — never pick a side for them. Relay `operator` and `external` steps verbatim; the CLI performs neither, and neither do you.
