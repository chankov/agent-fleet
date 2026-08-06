# Getting started

Agent Fleet installs deterministic pi workspace content. The public lifecycle is
**setup**, **doctor**, and **uninstall**; no coding agent or model is required.

```bash
# Interactive users follow the latest release.
npx @chankov/agent-fleet@latest setup

# CI and automation pin a version and name the selection.
npx @chankov/agent-fleet@1.0.0 setup --preset default --features none --yes
npx @chankov/agent-fleet@1.0.0 doctor
```

Choose **Default** for stable Fleet Core or **Full** for all stable,
platform-applicable catalogue roots. Default does not create voice configuration
or `.claude/`; Full may install the recorded Claude Code coms bridge. Features
are named additions after preset selection. See [npm-install.md](npm-install.md)
for migration and ownership rules.

Once a harness selection installs the managed launcher:

```bash
just fleet
just fleet hub
just fleet team docs --project af
just fleet doctor
```

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
