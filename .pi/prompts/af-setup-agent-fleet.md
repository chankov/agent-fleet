---
description: Guided setup — install agent-fleet artifacts into a workspace for a chosen coding agent
---

Load and follow the `guided-workspace-setup` skill before proceeding.

Run the guided install for a target workspace. If the user passed a workspace path, use it; otherwise ask. Confirm the coding agent (`pi` here unless the user says otherwise).

The skill is a front-end over the `agent-fleet` CLI's installer engine: `verify --json` supplies the menu (groups, profiles, per-item state), and `install` / `upgrade` / `uninstall` / `doctor --fix` do every write. **Do not copy, symlink, or delete an install target yourself** — the CLI records ownership in `.ai/agent-fleet-state.json`, and anything written by hand is invisible to every later run. The harness/extension closures (Fleet Core, the `justfile` managed region, the `.pi/agents` configs, the runtime script closure) are manifest data, so the CLI already pulls them in; you do not restate or reassemble them. Artifacts install as copies; never ask copy-vs-symlink and never pass `--method`.

Two things are yours rather than the CLI's: drafting `.ai/agent-fleet-overrides.md` from a scan of the project, and the `pi-voice-stt` provider Q&A (`.ai/stt.json` names env vars; the key goes in a gitignored `.env`).

**Bootstrap `pi-ask-user` first.** Before the menu, check whether the interaction package is available (bundled by `@chankov/agent-fleet`, recorded as a project package, or global). If it is missing, offer `pi install -l npm:pi-ask-user`, then **stop the pass** and ask the user to reload pi and re-run `/af-setup-agent-fleet` — the widget is not callable until then. Fall back to a text menu in this pass only if the user declines. The standalone package powers the setup menu and plain `pi` sessions; deterministic `just fleet` (`--no-extensions`) sessions get `ask_user` from the `ask-user-remote` harness, which loads stock `pi-ask-user` itself.

Drive every decision through the `ask_user` widget: ≤ 9 options and ≤ 8 `context` lines per call, options carrying the data (never a table in `context`). Open with the Express question backed by the manifest's profiles; group screens run only on `Custom`; drill-ins appear only behind `Customise`. Option titles carry `<name> ★ [state]`, descriptions say what picking it does in plain words. Leaving an installed item unpicked keeps it — removal is its own explicit screen and runs `uninstall`. Cancel is a no-op everywhere except the final confirmation.

If `verify` reports findings or broken items, offer `doctor --fix` before the menu — a broken workspace makes the menu lie about what is installed.

Print the plan as compact action-grouped lines before confirming, then confirm with one `displayMode: "inline"` single-select: `Apply — and remove the installer commands` (default) / `Apply — keep the installer commands` / `Adjust picks` / `Cancel`. Ask before passing `--allow-exec` (the `npm ci` steps). Exit `3` means conflicts: show the `.new` files the CLI wrote and let the user decide — never pick a side for them. Relay `operator` and `external` steps verbatim; the CLI performs neither, and neither do you.
