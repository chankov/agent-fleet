# Getting started

Agent Fleet installs deterministic pi workspace content. The public lifecycle is
**setup**, **doctor**, and **uninstall**; no coding agent or model is required.

## Install a new repository

From the target repository in a real TTY, launch the installer with:

```bash
just fleet setup
```

This is the easiest TUI entry point: it resolves `npx @chankov/agent-fleet@latest
setup`, lets you choose **Default** or **Full** plus optional comma-separated
features, shows the exact plan, and asks once before applying. It needs npm registry
access unless `@latest` is cached. Use the package command directly if `just` is
unavailable; use explicit flags for automation.

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
```

Choose **Default** for stable Fleet Core or **Full** for all stable,
platform-applicable catalogue roots. Default does not create voice configuration
or `.claude/`; Full may install the recorded Claude Code coms bridge. Features
are named additions after preset selection. These are package commands; in an
Agent Fleet source checkout use `node bin/cli.js setup` instead. See
[npm-install.md](npm-install.md) for migration and ownership rules.

Once a harness selection installs the managed launcher:

```bash
just fleet
just fleet hub
just fleet team docs --project af
just fleet deps             # install nested .pi/extensions and .pi/harnesses dependencies
just fleet doctor
```

`pi update --extensions` does not update the npm installer. Run `just fleet setup`
to resolve `@latest` and reconcile the workspace; `just fleet install` was removed,
so use `setup` or `deps`.

Use `just fleet uninstall --yes` only for the self-hosted workspace lifecycle.
It removes the launcher last. Reinstall after that with the package CLI, not
`just`: `npx @chankov/agent-fleet@latest setup --preset default --features none --yes`.

For pi package-native skills/prompts instead of copied ones:

```bash
pi install -l npm:@chankov/agent-fleet
```

Do not mix copied and package-native skills/prompts. `doctor` identifies that
ownership overlap. Read [pi-setup.md](pi-setup.md) for runtime composition,
[agent-fleet-setup.md](agent-fleet-setup.md) for project configuration, and
[MIGRATION-agent-fleet.md](MIGRATION-agent-fleet.md) for the major-release matrix.
